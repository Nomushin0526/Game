/**
 * Thin Rapier wrapper.
 *
 * Only static geometry lives in the Rapier world: craft movement is kinematic
 * and driven by `flight.ts`, so the simulation keeps full control over
 * determinism. Rapier is used purely as a fast spatial query structure
 * (sphere casts for movement, ray casts for the beam weapon and AI line of
 * sight). It runs identically in the browser and under Node.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { Terrain } from '../maps/terrain.ts';
import { segmentHitsSphere, type CloudVolume, type MapData } from '../maps/types.ts';
import type { Vec3 } from './types.ts';

let initialised = false;

/** Must be awaited once per process before any `PhysicsWorld` is constructed. */
export async function initPhysics(): Promise<void> {
  if (initialised) return;
  await RAPIER.init();
  initialised = true;
}

export function isPhysicsReady(): boolean {
  return initialised;
}

export interface CastHit {
  /** Distance along the cast direction at which contact happened, metres. */
  distance: number;
  /** World-space contact point on the obstacle's surface. */
  point: Vec3;
  /** World-space surface normal of the obstacle, pointing back at the caster. */
  normal: Vec3;
}

export class PhysicsWorld {
  private readonly world: RAPIER.World;
  /** Re-used so a sphere cast does not allocate a new Rapier shape per tick. */
  private readonly probeCache = new Map<number, RAPIER.Ball>();
  private readonly identityRot = { x: 0, y: 0, z: 0, w: 1 };
  /**
   * Kept because a Rapier height field is a surface, not a sealed volume:
   * queries under it hit nothing at all, so "underground" has to be answered
   * by sampling the terrain rather than by asking the collider.
   */
  private readonly terrain: Terrain | undefined;
  private readonly floor: number;
  /**
   * Cloud is not in the Rapier world at all: it answers exactly one query,
   * `isBlocked`, and is transparent to every cast. Keeping it out of the
   * collider set is what makes craft and bolts pass straight through.
   */
  private readonly clouds: readonly CloudVolume[];

  constructor(map: MapData) {
    if (!initialised) {
      throw new Error('initPhysics() must be awaited before creating a PhysicsWorld');
    }
    // Gravity is zero: these are thrusters, not falling bodies.
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.terrain = map.terrain;
    this.floor = map.floor;
    this.clouds = map.clouds ?? [];

    this.addGround(map);
    if (map.terrain) this.addTerrain(map);
    for (const solid of map.solids) {
      if (solid.shape === 'box') {
        const rotY = solid.rotY ?? 0;
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed()
            .setTranslation(solid.pos.x, solid.pos.y, solid.pos.z)
            .setRotation(yawQuaternion(rotY)),
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(solid.size.x / 2, solid.size.y / 2, solid.size.z / 2),
          body,
        );
      } else {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(solid.pos.x, solid.pos.y, solid.pos.z),
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cylinder(solid.height / 2, solid.radius),
          body,
        );
      }
    }

    // Static geometry never moves, so one refresh of the query structure is enough.
    this.world.updateSceneQueries();
  }

  /**
   * A thick slab rather than a plane, so a fast craft cannot tunnel through it.
   * It sits entirely below `floor`, so relief always rises above it.
   */
  private addGround(map: MapData): void {
    const thickness = 10;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, map.floor - thickness / 2, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(map.size.x, thickness / 2, map.size.z),
      body,
    );
  }

  /**
   * Ground relief as a Rapier heightfield.
   *
   * Rapier stores heights column-major and scales them by `scale.y`, and its
   * grid is centred on the collider. `Terrain` uses that same layout, so the
   * buffer goes across untouched and physics agrees with `terrain.heightAt()`
   * and with the rendered mesh by construction.
   */
  private addTerrain(map: MapData): void {
    const terrain = map.terrain!;
    const cells = terrain.resolution;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, map.floor, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.heightfield(cells, cells, terrain.heights, {
        x: map.size.x,
        y: terrain.maxHeight,
        z: map.size.z,
      }),
      body,
    );
  }

  /**
   * Sweep a sphere of `radius` from `origin` along `dir` for `maxDistance`.
   * `dir` must be normalised. Returns the first contact, or null.
   */
  sphereCast(origin: Vec3, dir: Vec3, maxDistance: number, radius: number): CastHit | null {
    if (maxDistance <= 0) return null;
    const hit = this.world.castShape(
      origin,
      this.identityRot,
      dir,
      this.probe(radius),
      0,
      maxDistance,
      // Do not report a hit when the shape starts already overlapping: the
      // craft would otherwise get permanently pinned inside geometry.
      false,
    );
    if (!hit) return null;

    const distance = hit.time_of_impact;
    // `normal1` belongs to the collider being hit and points back along the
    // sweep; `normal2` is its opposite, on the moving shape.
    const normal = normalizeOr(hit.normal1, { x: -dir.x, y: -dir.y, z: -dir.z });
    return {
      distance,
      point: {
        x: origin.x + dir.x * distance - normal.x * radius,
        y: origin.y + dir.y * distance - normal.y * radius,
        z: origin.z + dir.z * distance - normal.z * radius,
      },
      normal,
    };
  }

  /** Hit-scan ray against static geometry. `dir` must be normalised. */
  raycast(origin: Vec3, dir: Vec3, maxDistance: number): CastHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true);
    if (!hit) return null;
    const distance = hit.timeOfImpact;
    return {
      distance,
      point: {
        x: origin.x + dir.x * distance,
        y: origin.y + dir.y * distance,
        z: origin.z + dir.z * distance,
      },
      normal: normalizeOr(hit.normal, { x: -dir.x, y: -dir.y, z: -dir.z }),
    };
  }

  /** Ground height at a world point, including relief. */
  groundHeight(x: number, z: number): number {
    return this.floor + (this.terrain?.heightAt(x, z) ?? 0);
  }

  /** True when a point sits at or below the ground surface. */
  isUnderground(p: Vec3, clearance = 0): boolean {
    return p.y < this.groundHeight(p.x, p.z) + clearance;
  }

  /**
   * True when geometry blocks the straight line between two points.
   *
   * An endpoint below the ground counts as blocked: a height field has no
   * underside, so a sightline running under a hill would otherwise come back
   * clear.
   */
  isBlocked(from: Vec3, to: Vec3): boolean {
    if (this.isUnderground(from) || this.isUnderground(to)) return true;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return false;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    if (this.raycast(from, dir, dist) !== null) return true;
    return this.inCloud(from, to);
  }

  /** True when a sight line passes through any bank of cloud. */
  inCloud(from: Vec3, to: Vec3): boolean {
    for (const cloud of this.clouds) {
      if (segmentHitsSphere(from, to, cloud.pos, cloud.radius)) return true;
    }
    return false;
  }

  /** True when a point is inside cloud, which is how a craft knows it is hidden. */
  isInsideCloud(pos: Vec3): boolean {
    return this.inCloud(pos, pos);
  }

  /** True when a sphere at `pos` sits in open air, above ground and clear of solids. */
  isClear(pos: Vec3, radius: number): boolean {
    if (this.isUnderground(pos, radius)) return false;
    return (
      this.world.intersectionWithShape(pos, this.identityRot, this.probe(radius)) === null
    );
  }

  private probe(radius: number): RAPIER.Ball {
    let ball = this.probeCache.get(radius);
    if (!ball) {
      ball = new RAPIER.Ball(radius);
      this.probeCache.set(radius, ball);
    }
    return ball;
  }

  /** Release the underlying wasm allocation. */
  dispose(): void {
    this.world.free();
  }
}

function yawQuaternion(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function normalizeOr(v: { x: number; y: number; z: number }, fallback: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-6) return fallback;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
