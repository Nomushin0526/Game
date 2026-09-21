/**
 * Flight control: turns a `PlayerInput` into motion, and punishes sloppy flying
 * by making crashes hurt (DESIGN.md 2.3).
 *
 * Movement is kinematic. Velocity is integrated by hand and the resulting step
 * is swept through the static world with a sphere cast, which keeps the result
 * bit-for-bit reproducible for a given input sequence.
 */

import type { SkyTagConfig } from './config.ts';
import {
  add,
  clamp,
  clampLength,
  dot,
  forwardVector,
  length,
  normalize,
  rightVector,
  scale,
  wrapAngle,
} from './math.ts';
import type { PhysicsWorld } from './physics.ts';
import { applyDamage } from './damage.ts';
import type { EntityState, PlayerInput, SimEvent, Vec3 } from './types.ts';

/** Axis-aligned bounds of the playfield, including the invisible walls. */
export interface ArenaBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function boundsFromMap(map: {
  size: { x: number; z: number };
  ceiling: number;
  floor: number;
}): ArenaBounds {
  return {
    minX: -map.size.x / 2,
    maxX: map.size.x / 2,
    minY: map.floor,
    maxY: map.ceiling,
    minZ: -map.size.z / 2,
    maxZ: map.size.z / 2,
  };
}

export interface FlightContext {
  dt: number;
  config: SkyTagConfig;
  physics: PhysicsWorld;
  bounds: ArenaBounds;
  /** When false the craft coasts and input is ignored (countdown, round over). */
  controlEnabled: boolean;
}

/**
 * Advance one craft by `dt`. Mutates `entity`.
 * Returns the events from a crash hard enough to be punished, else an empty array.
 */
export function stepFlight(
  entity: EntityState,
  input: PlayerInput,
  ctx: FlightContext,
): SimEvent[] {
  const { dt, config, bounds } = ctx;
  const flight = config.flight;
  const loadout = config.loadout[entity.team];

  // Aim always tracks the input, even while stunned: you can look around while
  // your thrusters are rebooting, you just cannot steer.
  entity.aimYaw = wrapAngle(input.aimYaw);
  entity.aimPitch = clamp(input.aimPitch, -flight.maxPitch, flight.maxPitch);

  const stunned = entity.stunTimer > 0;
  if (stunned) entity.stunTimer = Math.max(0, entity.stunTimer - dt);

  const canSteer = ctx.controlEnabled && !stunned && entity.alive;
  const wish = canSteer ? wishDirection(entity, input) : { x: 0, y: 0, z: 0 };
  const wishStrength = length(wish);

  updateBoost(entity, input, canSteer && wishStrength > 0, config, dt);

  const boosted = entity.boosting ? loadout.boostMultiplier : 1;
  const maxSpeed = loadout.cruiseSpeed * boosted * tempo(entity, config);
  const target = scale(wish, maxSpeed);
  const agility = loadout.accel;
  const accel = entity.boosting ? agility + flight.boostAccel : agility;
  const rate = wishStrength > 0 ? accel : flight.decel;

  const delta = { x: target.x - entity.vel.x, y: target.y - entity.vel.y, z: target.z - entity.vel.z };
  const deltaLen = length(delta);
  const stepLen = rate * dt;
  entity.vel = deltaLen <= stepLen ? target : add(entity.vel, scale(scale(delta, 1 / deltaLen), stepLen));

  const events = sweepMove(entity, ctx);
  applyBounds(entity, bounds, flight.bodyRadius);
  return events;
}

/**
 * Top-speed multiplier from the items currently on the craft.
 *
 * Both act on top speed rather than acceleration, so a snared runner still
 * handles the same and a hunter in overdrive does not become twitchy — what
 * changes is only whether one can out-run the other, which is the whole point
 * of both items. They multiply, so a snared craft in overdrive is somewhere in
 * between rather than getting the better of the two for free.
 */
function tempo(entity: EntityState, config: SkyTagConfig): number {
  const items = config.items;
  const surge = entity.overdriveTimer > 0 ? items.overdrive.speedMultiplier : 1;
  const drag = entity.snareTimer > 0 ? items.snare.speedMultiplier : 1;
  return surge * drag;
}

/** Movement wish in world space. Vertical thrust is world-up, not craft-up. */
function wishDirection(entity: EntityState, input: PlayerInput): Vec3 {
  const fwd = forwardVector(entity.aimYaw, entity.aimPitch);
  const right = rightVector(entity.aimYaw);
  const wish = {
    x: fwd.x * input.move.z + right.x * input.move.x,
    y: fwd.y * input.move.z + input.move.y,
    z: fwd.z * input.move.z + right.z * input.move.x,
  };
  // Diagonals must not be faster than a straight line.
  return clampLength(wish, 1);
}

function updateBoost(
  entity: EntityState,
  input: PlayerInput,
  thrusting: boolean,
  config: SkyTagConfig,
  dt: number,
): void {
  const flight = config.flight;
  const loadout = config.loadout[entity.team];
  const wants = input.boost && thrusting;
  // Hysteresis: re-engaging needs a minimum reserve, so a drained gauge cannot
  // stutter on and off every tick.
  const threshold = entity.boosting ? 0 : flight.boostMinToEngage;
  entity.boosting = wants && entity.boostFuel > threshold;

  if (entity.boosting) {
    // Overdrive runs the thrusters off its own supply: the surge is worth
    // spending a charge on precisely because it does not also empty the gauge
    // that the chase afterwards depends on.
    if (entity.overdriveTimer <= 0) {
      entity.boostFuel = Math.max(0, entity.boostFuel - loadout.boostDrain * dt);
      if (entity.boostFuel === 0) entity.boosting = false;
    }
  } else {
    entity.boostFuel = Math.min(flight.boostCapacity, entity.boostFuel + loadout.boostRegen * dt);
  }
}

/**
 * Integrate position along the velocity.
 *
 * A hard impact stops the craft outright and is reported. A glancing contact
 * makes it slide along the surface and continue with the leftover time, so
 * hugging a wall stays smooth instead of snagging every tick.
 */
function sweepMove(entity: EntityState, ctx: FlightContext): SimEvent[] {
  const { config, physics } = ctx;
  const flight = config.flight;
  const maxSlides = 3;
  let remaining = ctx.dt;

  for (let iteration = 0; iteration < maxSlides && remaining > 1e-6; iteration++) {
    const step = scale(entity.vel, remaining);
    const distance = length(step);
    if (distance < 1e-9) return [];

    const dir = scale(step, 1 / distance);
    const hit = physics.sphereCast(entity.pos, dir, distance + flight.skinWidth, flight.bodyRadius);

    if (!hit || hit.distance > distance) {
      entity.pos = add(entity.pos, step);
      return [];
    }

    const travel = Math.max(0, hit.distance - flight.skinWidth);
    entity.pos = add(entity.pos, scale(dir, travel));

    // Speed directed into the surface. Positive means we drove into it.
    const closingSpeed = -dot(entity.vel, hit.normal);
    if (closingSpeed >= flight.minImpactSpeed) {
      entity.vel = scale(entity.vel, flight.collisionRestitution);
      const damage = flight.collisionDamage;
      entity.stunTimer = flight.collisionStun;
      return [
        {
          type: 'collision',
          entityId: entity.id,
          pos: { ...entity.pos },
          impactSpeed: closingSpeed,
          normal: hit.normal,
          damage,
        },
        ...applyDamage(entity, damage, 'collision', null, config),
      ];
    }

    // Gentle contact: project the velocity onto the surface and keep going.
    const into = dot(entity.vel, hit.normal);
    if (into < 0) entity.vel = add(entity.vel, scale(hit.normal, -into));
    remaining *= 1 - travel / distance;
  }
  return [];
}

/** Invisible walls: clamp the position and kill the outward velocity component. */
function applyBounds(entity: EntityState, b: ArenaBounds, radius: number): void {
  const p = entity.pos;
  const v = entity.vel;

  if (p.x < b.minX + radius) { p.x = b.minX + radius; if (v.x < 0) v.x = 0; }
  else if (p.x > b.maxX - radius) { p.x = b.maxX - radius; if (v.x > 0) v.x = 0; }

  if (p.y < b.minY + radius) { p.y = b.minY + radius; if (v.y < 0) v.y = 0; }
  else if (p.y > b.maxY - radius) { p.y = b.maxY - radius; if (v.y > 0) v.y = 0; }

  if (p.z < b.minZ + radius) { p.z = b.minZ + radius; if (v.z < 0) v.z = 0; }
  else if (p.z > b.maxZ - radius) { p.z = b.maxZ - radius; if (v.z > 0) v.z = 0; }
}

/** Unit vector the craft is currently pointing along. */
export function entityForward(entity: EntityState): Vec3 {
  return normalize(forwardVector(entity.aimYaw, entity.aimPitch));
}
