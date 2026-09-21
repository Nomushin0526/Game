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
  const agility = loadout.accel;
  const thrust = entity.boosting ? agility + flight.boostAccel : agility;
  entity.vel = integrate(entity.vel, wish, wishStrength, thrust, maxSpeed, flight, dt);
  applyDash(entity, input, wish, wishStrength, canSteer, config, dt);

  const events = sweepMove(entity, ctx);
  applyBounds(entity, bounds, flight.bodyRadius);
  return events;
}

/**
 * Spend a dash: one tick's worth of speed, all at once.
 *
 * Added straight to the velocity rather than raising the top speed, so it is
 * felt as a shove and then bleeds away on the ordinary drag curve. Aimed
 * along whatever the craft is asking for, or straight ahead when it is asking
 * for nothing, so a dash out of a standstill still goes somewhere.
 */
function applyDash(
  entity: EntityState,
  input: PlayerInput,
  wish: Vec3,
  wishStrength: number,
  canSteer: boolean,
  config: SkyTagConfig,
  dt: number,
): void {
  const flight = config.flight;
  entity.dashCooldown = Math.max(0, entity.dashCooldown - dt);

  if (!input.dash || !canSteer) return;
  if (entity.dashCooldown > 0 || entity.boostFuel < flight.dashCost) return;

  const direction = wishStrength > 1e-6 ? scale(wish, 1 / wishStrength) : entityForward(entity);
  entity.vel = add(entity.vel, scale(direction, flight.dashImpulse));
  entity.boostFuel -= flight.dashCost;
  entity.dashCooldown = flight.dashCooldown;
}

/**
 * Advance velocity by one step of thrust against drag.
 *
 * The craft used to steer its velocity vector straight at a target velocity
 * at a fixed rate, which is simple and reads as flat: accelerating, braking
 * and turning all took the same uniform half-second, and releasing the stick
 * stopped you in a straight line with nothing carried over.
 *
 * Thrust and drag instead give each of those a different shape. Under thrust
 * the drag coefficient is fixed by the top speed (`thrust / maxSpeed`), so
 * terminal velocity still lands exactly on `maxSpeed` and none of the balance
 * numbers move — but the *old* velocity now decays while the new one builds,
 * so a turn carves instead of pivoting. With no thrust, speed bleeds off at
 * `coastDrag` per second, so the craft glides.
 */
function integrate(
  vel: Vec3,
  wish: Vec3,
  wishStrength: number,
  thrust: number,
  maxSpeed: number,
  flight: SkyTagConfig['flight'],
  dt: number,
): Vec3 {
  const thrusting = wishStrength > 1e-6 && maxSpeed > 1e-6;
  // Chosen so that thrust and drag balance exactly at `maxSpeed`; anything
  // else would quietly move every speed in the game.
  const drag = thrusting ? thrust / maxSpeed : flight.coastDrag;

  // Scaled by the wish itself rather than normalised, so a half-deflected
  // stick is half thrust and settles at half the top speed.
  const accel = thrusting ? scale(wish, thrust) : { x: 0, y: 0, z: 0 };
  // No ceiling is applied. Drag is its own bound: thrusting from `maxSpeed`
  // on one axis to `maxSpeed` on another, the magnitude only ever dips (to
  // `maxSpeed / root 2` at the midpoint) and never exceeds. Anything faster
  // than that, such as a dash impulse, bleeds off on the same curve rather
  // than being clipped, which is what makes an impulse worth spending.
  return {
    x: vel.x + (accel.x - vel.x * drag) * dt,
    y: vel.y + (accel.y - vel.y * drag) * dt,
    z: vel.z + (accel.z - vel.z * drag) * dt,
  };
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
