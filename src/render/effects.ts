/**
 * Bolts in flight, plus the transient visuals around them: muzzle flashes, hit
 * sparks, crashes and kills.
 *
 * Bolts are drawn from live simulation state each frame rather than from
 * events, because they persist across ticks. Everything else is fed from the
 * event list and driven by real frame time, not the fixed tick, so effects keep
 * fading smoothly while the world is paused. Meshes are pooled because a held
 * trigger produces several per second.
 */

import * as THREE from 'three';
import type { ProjectileState, SimEvent, Vec3 } from '../sim/types.ts';

/** Purely cosmetic timings and sizes; none of these affect the simulation. */
const MUZZLE_LIFETIME = 0.06;
/**
 * Bolts are deliberately chunky. From your own chase camera a shot flies almost
 * straight down the view axis, so a hairline tracer reads as nothing at all.
 */
const BOLT_RADIUS = 0.34;
/** Length of the drawn bolt, metres. Longer reads as faster. */
const BOLT_LENGTH = 5;
const SPARK_LIFETIME = 0.35;
const CRASH_LIFETIME = 0.5;
const DEATH_LIFETIME = 1.1;
const FLASH_LIFETIME = 0.55;

interface Active {
  mesh: THREE.Mesh;
  age: number;
  lifetime: number;
  /** Radius the puff grows to; unset for beams, which do not grow. */
  growTo?: number;
  baseScale: number;
}

export class Effects {
  private readonly active: Active[] = [];
  private readonly beamPool: THREE.Mesh[] = [];
  private readonly puffPool: THREE.Mesh[] = [];
  private readonly beamGeometry = new THREE.CylinderGeometry(BOLT_RADIUS, BOLT_RADIUS, 1, 8, 1, true);
  /** Live bolts, keyed by projectile id, reusing the same pooled meshes. */
  private readonly bolts = new Map<number, THREE.Mesh>();
  private readonly puffGeometry = new THREE.SphereGeometry(1, 10, 8);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly teamColor: (entityId: number) => number,
  ) {}

  /** Turn one tick's events into visuals. */
  spawn(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'fire': {
          // A short stub at the muzzle: the bolt itself is drawn from state.
          const tip = {
            x: event.origin.x + event.dir.x * BOLT_LENGTH,
            y: event.origin.y + event.dir.y * BOLT_LENGTH,
            z: event.origin.z + event.dir.z * BOLT_LENGTH,
          };
          this.addBeam(event.origin, tip, this.teamColor(event.shooterId));
          break;
        }
        case 'projectileHit':
          // Only geometry strikes spark here. A bolt that ran out of range
          // fizzles silently, and one that hit a craft is covered by the
          // damage event below, which would otherwise double the puff.
          if (!event.expired && event.hitEntityId === null) {
            this.addPuff(event.pos, 0.4, 1.8, SPARK_LIFETIME, 0xd8dee8);
          }
          break;
        case 'damage':
          if (event.cause === 'beam') this.addPuff(event.pos, 0.6, 2.2, SPARK_LIFETIME, 0xffe07a);
          break;
        case 'collision':
          this.addPuff(event.pos, 0.8, 3.2, CRASH_LIFETIME, 0xffb04a);
          break;
        case 'death':
          this.addPuff(event.pos, 1.5, 11, DEATH_LIFETIME, 0xff6a3a);
          break;
        case 'flashBurst':
          // Sized to the real blast radius, so you can see who it caught.
          this.addPuff(event.pos, 1, event.radius, FLASH_LIFETIME, 0xffffff);
          break;
        case 'itemUsed':
          if (event.kind === 'decoy') this.addPuff(event.pos, 1, 5, SPARK_LIFETIME, 0x9fe8ff);
          if (event.kind === 'shield') this.addPuff(event.pos, 2, 6, SPARK_LIFETIME, 0x7fd4ff);
          // A ping is a ring that runs out past weapon range, so both players
          // can see one has gone out even if only one of them knows why.
          if (event.kind === 'scan') this.addPuff(event.pos, 2, 60, FLASH_LIFETIME, 0x8affc8);
          if (event.kind === 'overdrive') this.addPuff(event.pos, 2, 8, SPARK_LIFETIME, 0xffb04a);
          break;
        case 'snareBurst':
          this.addPuff(event.pos, 1, event.radius, FLASH_LIFETIME, 0xb07aff);
          break;
        case 'shieldAbsorbed':
          this.addPuff(event.pos, 3.5, event.broke ? 7 : 5, SPARK_LIFETIME, 0x7fd4ff);
          break;
        case 'decoyGone':
          // Only a popped decoy bursts; an expired one just fades out.
          if (event.popped) this.addPuff(event.pos, 1, 6, SPARK_LIFETIME, 0x9fe8ff);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Draw the bolts that are currently in the air.
   *
   * Their position is extrapolated by `alpha` of a tick, the same way craft are
   * interpolated, so a bolt does not visibly stutter between simulation steps.
   */
  syncProjectiles(projectiles: readonly ProjectileState[], alpha: number, fixedDt: number): void {
    const seen = new Set<number>();

    for (const bolt of projectiles) {
      seen.add(bolt.id);
      let mesh = this.bolts.get(bolt.id);
      if (!mesh) {
        mesh = this.beamPool.pop() ?? this.makeMesh(this.beamGeometry, THREE.NormalBlending);
        (mesh.material as THREE.MeshBasicMaterial).color.setHex(this.teamColor(bolt.ownerId));
        (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
        mesh.scale.set(1, BOLT_LENGTH, 1);
        mesh.visible = true;
        this.scene.add(mesh);
        this.bolts.set(bolt.id, mesh);
      }

      const lead = alpha * fixedDt;
      const head: Vec3 = {
        x: bolt.pos.x + bolt.vel.x * lead,
        y: bolt.pos.y + bolt.vel.y * lead,
        z: bolt.pos.z + bolt.vel.z * lead,
      };
      const direction = new THREE.Vector3(bolt.vel.x, bolt.vel.y, bolt.vel.z).normalize();
      // The cylinder runs along Y and is centred, so pull it back half a length
      // to put its nose at the bolt's actual position.
      mesh.position.set(head.x, head.y, head.z).addScaledVector(direction, -BOLT_LENGTH / 2);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    }

    for (const [id, mesh] of this.bolts) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      mesh.visible = false;
      this.beamPool.push(mesh);
      this.bolts.delete(id);
    }
  }

  /** Age everything by one rendered frame and retire what has expired. */
  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i]!;
      item.age += dt;
      const t = item.age / item.lifetime;

      if (t >= 1) {
        this.retire(item);
        this.active.splice(i, 1);
        continue;
      }

      const material = item.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 1 - t;
      if (item.growTo !== undefined) {
        const scale = item.baseScale + (item.growTo - item.baseScale) * t;
        item.mesh.scale.setScalar(scale);
      }
    }
  }

  /** Drop everything, e.g. between rounds. */
  clear(): void {
    for (const item of this.active) this.retire(item);
    this.active.length = 0;
    for (const [id, mesh] of this.bolts) {
      this.scene.remove(mesh);
      mesh.visible = false;
      this.beamPool.push(mesh);
      this.bolts.delete(id);
    }
  }

  private addBeam(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, color: number): void {
    const start = new THREE.Vector3(from.x, from.y, from.z);
    const end = new THREE.Vector3(to.x, to.y, to.z);
    const length = start.distanceTo(end);
    if (length < 0.01) return;

    const mesh = this.beamPool.pop() ?? this.makeMesh(this.beamGeometry, THREE.NormalBlending);
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    // The cylinder runs along Y, so orient it and stretch it to the beam length.
    mesh.position.copy(start).lerp(end, 0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      end.clone().sub(start).normalize(),
    );
    mesh.scale.set(1, length, 1);
    mesh.visible = true;
    (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    this.scene.add(mesh);
    this.active.push({ mesh, age: 0, lifetime: MUZZLE_LIFETIME, baseScale: 1 });
  }

  private addPuff(
    at: { x: number; y: number; z: number },
    from: number,
    to: number,
    lifetime: number,
    color: number,
  ): void {
    const mesh = this.puffPool.pop() ?? this.makeMesh(this.puffGeometry, THREE.AdditiveBlending);
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    mesh.position.set(at.x, at.y, at.z);
    mesh.quaternion.identity();
    mesh.scale.setScalar(from);
    mesh.visible = true;
    this.scene.add(mesh);
    this.active.push({ mesh, age: 0, lifetime, growTo: to, baseScale: from });
  }

  /**
   * Beams blend normally so they stay readable against the bright sky, where
   * additive blending would wash them out. Puffs stay additive: they go off
   * against geometry and read as light.
   */
  private makeMesh(geometry: THREE.BufferGeometry, blending: THREE.Blending): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending,
    });
    return new THREE.Mesh(geometry, material);
  }

  private retire(item: Active): void {
    this.scene.remove(item.mesh);
    item.mesh.visible = false;
    const pool = item.growTo === undefined ? this.beamPool : this.puffPool;
    pool.push(item.mesh);
  }
}
