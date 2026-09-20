/**
 * Bolts in flight.
 *
 * Each bolt is swept through the world once per tick and stops at the first
 * thing it meets — a craft or geometry, whichever is nearer. Sweeping rather
 * than sampling the end point matters: at 180 m/s a bolt covers 3 m per tick,
 * which is more than a craft is wide, so a point test would shoot straight
 * through people.
 */

import type { SkyTagConfig } from './config.ts';
import { applyDamage } from './damage.ts';
import { detonateFlash } from './items.ts';
import { add, raySphere, scale } from './math.ts';
import type { PhysicsWorld } from './physics.ts';
import type { DecoyState, EntityState, ProjectileState, SimEvent, Vec3 } from './types.ts';

export interface ProjectileContext {
  dt: number;
  config: SkyTagConfig;
  physics: PhysicsWorld;
}

export interface ProjectileStepResult {
  /** Bolts still flying after this tick. */
  survivors: ProjectileState[];
  events: SimEvent[];
}

/**
 * Advance every bolt by one tick, resolving impacts and expiry.
 * Mutates the craft it hits; returns the bolts that are still alive.
 */
export function stepProjectiles(
  projectiles: readonly ProjectileState[],
  entities: readonly EntityState[],
  decoys: DecoyState[],
  ctx: ProjectileContext,
): ProjectileStepResult {
  const survivors: ProjectileState[] = [];
  const events: SimEvent[] = [];

  for (const bolt of projectiles) {
    const step = scale(bolt.vel, ctx.dt);
    const distance = Math.hypot(step.x, step.y, step.z);

    if (distance < 1e-9) {
      // A bolt with no velocity would never expire by travel, so age it anyway.
      bolt.life -= ctx.dt;
      if (bolt.life > 0) survivors.push(bolt);
      continue;
    }

    const dir = scale(step, 1 / distance);
    const speed = distance / ctx.dt;
    // Clamp the step to whatever flight the bolt has left, so it stops exactly
    // at its maximum range rather than overshooting by up to a full tick.
    const travel = Math.min(distance, bolt.life * speed);
    const impact = findImpact(bolt, dir, travel, entities, decoys, ctx);

    if (impact) {
      const point = add(bolt.pos, scale(dir, impact.distance));

      // A grenade that runs into something bursts there rather than at its fuse.
      if (bolt.kind === 'flash') {
        events.push(...detonateFlash(bolt, point, entities, ctx.config, ctx.physics));
        continue;
      }

      events.push({
        type: 'projectileHit',
        projectileId: bolt.id,
        ownerId: bolt.ownerId,
        pos: point,
        hitEntityId: impact.target?.id ?? null,
        expired: false,
      });

      // Popping a decoy costs the shot but tells the shooter it was a phantom.
      if (impact.decoy) {
        const index = decoys.indexOf(impact.decoy);
        if (index >= 0) decoys.splice(index, 1);
        events.push({ type: 'decoyGone', decoyId: impact.decoy.id, pos: point, popped: true });
        continue;
      }

      if (impact.target) {
        const owner = entities.find((e) => e.id === bolt.ownerId);
        if (owner) owner.shotsHit++;
        events.push(...applyDamage(impact.target, bolt.damage, 'beam', bolt.ownerId, ctx.config));
      }
      continue;
    }

    bolt.pos = add(bolt.pos, scale(dir, travel));
    bolt.life -= travel / speed;
    if (bolt.life <= 1e-9) {
      // A bolt at maximum range just fizzles; a grenade's fuse running out is
      // the whole point of it.
      if (bolt.kind === 'flash') {
        events.push(...detonateFlash(bolt, bolt.pos, entities, ctx.config, ctx.physics));
      } else {
        events.push({
          type: 'projectileHit',
          projectileId: bolt.id,
          ownerId: bolt.ownerId,
          pos: { ...bolt.pos },
          hitEntityId: null,
          expired: true,
        });
      }
      continue;
    }
    survivors.push(bolt);
  }

  return { survivors, events };
}

interface Impact {
  distance: number;
  /** The craft that was struck, or null for geometry or a decoy. */
  target: EntityState | null;
  /** The phantom that was popped, or null. */
  decoy: DecoyState | null;
}

/** The nearest of the craft, the decoys and the geometry along this sweep. */
function findImpact(
  bolt: ProjectileState,
  dir: Vec3,
  travel: number,
  entities: readonly EntityState[],
  decoys: readonly DecoyState[],
  ctx: ProjectileContext,
): Impact | null {
  const { config, physics } = ctx;
  const radius = config.weapon.projectileRadius;

  let nearest = travel;
  let target: EntityState | null = null;
  let decoy: DecoyState | null = null;

  for (const entity of entities) {
    // A bolt never hits the craft that fired it, which would otherwise happen
    // immediately at the muzzle.
    if (entity.id === bolt.ownerId || !entity.alive) continue;
    const hit = raySphere(bolt.pos, dir, entity.pos, config.weapon.hitRadius + radius, nearest);
    if (hit === null) continue;
    nearest = hit;
    target = entity;
    decoy = null;
  }

  // Decoys are shootable, which is exactly how a hunter finds out it has been
  // chasing one. A craft behind a decoy is still hit first if it is nearer.
  for (const phantom of decoys) {
    if (phantom.ownerId === bolt.ownerId) continue;
    const hit = raySphere(bolt.pos, dir, phantom.pos, config.items.decoy.hitRadius + radius, nearest);
    if (hit === null) continue;
    nearest = hit;
    target = null;
    decoy = phantom;
  }

  const geometry = physics.sphereCast(bolt.pos, dir, nearest, radius);
  if (geometry && geometry.distance <= nearest) {
    return { distance: geometry.distance, target: null, decoy: null };
  }
  if (target) return { distance: nearest, target, decoy: null };
  return decoy ? { distance: nearest, target: null, decoy } : null;
}

/** Build a bolt leaving `shooter`'s muzzle along `dir`. */
export function spawnProjectile(
  id: number,
  shooter: EntityState,
  dir: Vec3,
  config: SkyTagConfig,
): ProjectileState {
  const loadout = config.loadout[shooter.team];
  return {
    id,
    kind: 'bolt',
    ownerId: shooter.id,
    team: shooter.team,
    pos: add(shooter.pos, scale(dir, config.weapon.muzzleOffset)),
    // Bolts are fired from a moving craft but do not inherit its velocity:
    // where the sight is pointing is where the shot goes, which is what a
    // player expects and what makes the AI's lead calculation well defined.
    vel: scale(dir, loadout.projectileSpeed),
    life: loadout.range / loadout.projectileSpeed,
    damage: loadout.damage,
  };
}

/** Seconds a bolt of this loadout stays alive. */
export function projectileLifetime(config: SkyTagConfig, team: EntityState['team']): number {
  const loadout = config.loadout[team];
  return loadout.range / loadout.projectileSpeed;
}
