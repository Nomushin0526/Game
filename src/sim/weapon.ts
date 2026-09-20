/**
 * The beam gun: hit-scan, per-team damage, and heat management.
 *
 * A shot is resolved the instant it is fired. The ray is tested against every
 * other craft and against the world; the nearest of the two wins, so cover
 * genuinely blocks fire rather than being shot through.
 */

import type { SkyTagConfig } from './config.ts';
import { entityForward } from './flight.ts';
import { add, dot, scale, sub } from './math.ts';
import type { PhysicsWorld } from './physics.ts';
import { applyDamage } from './damage.ts';
import type { EntityState, PlayerInput, SimEvent, Vec3 } from './types.ts';

export interface WeaponContext {
  dt: number;
  config: SkyTagConfig;
  physics: PhysicsWorld;
  /** False during the countdown and after the round is decided. */
  controlEnabled: boolean;
}

/**
 * Advance one craft's gun by `dt` and resolve a shot if it fired.
 * Mutates `shooter` and, on a hit, the craft it hit.
 */
export function stepWeapon(
  shooter: EntityState,
  input: PlayerInput,
  others: readonly EntityState[],
  ctx: WeaponContext,
): SimEvent[] {
  const { dt, config } = ctx;
  const loadout = config.loadout[shooter.team];
  const events: SimEvent[] = [];

  shooter.fireCooldown = Math.max(0, shooter.fireCooldown - dt);
  shooter.invulnTimer = Math.max(0, shooter.invulnTimer - dt);
  shooter.sinceLastShot += dt;

  if (shooter.overheated) {
    shooter.cooldownRemaining = Math.max(0, shooter.cooldownRemaining - dt);
    if (shooter.cooldownRemaining === 0) {
      shooter.overheated = false;
      shooter.heat = 0;
    }
    return events;
  }

  if (!canFire(shooter, input, ctx)) {
    // Heat bleeds off between bursts only. The delay matters: most ticks inside
    // a burst are waiting on `fireInterval`, and decaying through those would
    // mean a held trigger could never overheat.
    if (shooter.sinceLastShot >= config.weapon.heatDecayDelay) {
      shooter.heat = Math.max(0, shooter.heat - config.weapon.heatDecay * dt);
    }
    return events;
  }

  shooter.fireCooldown = loadout.fireInterval;
  shooter.sinceLastShot = 0;
  shooter.shotsFired++;
  shooter.heat = Math.min(loadout.heatCapacity, shooter.heat + 1);
  if (shooter.heat >= loadout.heatCapacity) {
    shooter.overheated = true;
    shooter.cooldownRemaining = loadout.cooldownTime;
    events.push({ type: 'overheat', entityId: shooter.id });
  }

  events.push(...resolveShot(shooter, others, ctx));
  return events;
}

function canFire(shooter: EntityState, input: PlayerInput, ctx: WeaponContext): boolean {
  return (
    input.fire &&
    ctx.controlEnabled &&
    shooter.alive &&
    shooter.stunTimer <= 0 &&
    shooter.fireCooldown <= 0
  );
}

/** Trace the beam and apply damage to whatever it reaches first. */
function resolveShot(
  shooter: EntityState,
  others: readonly EntityState[],
  ctx: WeaponContext,
): SimEvent[] {
  const { config, physics } = ctx;
  const loadout = config.loadout[shooter.team];
  const dir = entityForward(shooter);
  const origin = add(shooter.pos, scale(dir, config.weapon.muzzleOffset));

  // Geometry first: it caps how far the beam can possibly reach.
  const geometryHit = physics.raycast(origin, dir, loadout.range);
  let reach = geometryHit ? geometryHit.distance : loadout.range;
  let victim: EntityState | null = null;

  for (const other of others) {
    if (other.id === shooter.id || !other.alive) continue;
    const t = raySphere(origin, dir, other.pos, config.weapon.hitRadius, reach);
    if (t === null) continue;
    reach = t;
    victim = other;
  }

  const end: Vec3 = add(origin, scale(dir, reach));
  const events: SimEvent[] = [
    { type: 'beam', shooterId: shooter.id, origin, end, hitEntityId: victim?.id ?? null },
  ];

  if (victim) {
    shooter.shotsHit++;
    events.push(...applyDamage(victim, loadout.damage, 'beam', shooter.id, config));
  }
  return events;
}

/**
 * Distance along the ray to the first intersection with a sphere, or null.
 * Only hits in front of the origin and within `maxDistance` count.
 */
export function raySphere(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDistance: number,
): number | null {
  const toCenter = sub(center, origin);
  const along = dot(toCenter, dir);
  const distanceSq = dot(toCenter, toCenter) - along * along;
  const radiusSq = radius * radius;
  if (distanceSq > radiusSq) return null;

  const half = Math.sqrt(radiusSq - distanceSq);
  // Near intersection first; if we start inside the sphere, use the entry point 0.
  const near = along - half;
  const t = near >= 0 ? near : along + half >= 0 ? 0 : null;
  if (t === null || t > maxDistance) return null;
  return t;
}
