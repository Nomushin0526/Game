/**
 * Transient visuals: beams, hit sparks, crashes and kills.
 *
 * Fed from the simulation's event list and driven by real frame time, not the
 * fixed tick, so effects keep fading smoothly while the world is paused.
 * Meshes are pooled because a held trigger produces several per second.
 */

import * as THREE from 'three';
import type { SimEvent } from '../sim/types.ts';

/** Purely cosmetic timings; none of these affect the simulation. */
const BEAM_LIFETIME = 0.13;
/**
 * Beams are deliberately chunky. From your own chase camera a shot goes almost
 * straight down the view axis, so a hairline tracer reads as nothing at all.
 */
const BEAM_RADIUS = 0.26;
const SPARK_LIFETIME = 0.35;
const CRASH_LIFETIME = 0.5;
const DEATH_LIFETIME = 1.1;

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
  private readonly beamGeometry = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, 1, 8, 1, true);
  private readonly puffGeometry = new THREE.SphereGeometry(1, 10, 8);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly teamColor: (entityId: number) => number,
  ) {}

  /** Turn one tick's events into visuals. */
  spawn(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'beam':
          this.addBeam(event.origin, event.end, this.teamColor(event.shooterId));
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
        default:
          break;
      }
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
    this.scene.add(mesh);
    this.active.push({ mesh, age: 0, lifetime: BEAM_LIFETIME, baseScale: 1 });
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
