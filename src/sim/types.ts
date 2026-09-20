/**
 * Core value types shared by the simulation.
 *
 * Nothing in `src/sim/` may import from `src/render/`, `src/input/` or `three`.
 * The simulation has to stay runnable head-less under plain Node.js.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Which side an entity is playing this round. */
export type Team = 'hunter' | 'runner';

/**
 * The single input channel into the simulation.
 *
 * Human players, CPU brains and (later) remote peers all produce this exact
 * shape, so `world.step()` never needs to know where a command came from.
 */
export interface PlayerInput {
  /** Local-frame movement wish, each component clamped to -1..1. */
  move: { x: number; y: number; z: number };
  /** Yaw in radians. 0 faces -Z, positive turns towards -X. */
  aimYaw: number;
  /** Pitch in radians, positive looks up. Clamped by config.flight.maxPitch. */
  aimPitch: number;
  fire: boolean;
  boost: boolean;
}

export function neutralInput(): PlayerInput {
  return {
    move: { x: 0, y: 0, z: 0 },
    aimYaw: 0,
    aimPitch: 0,
    fire: false,
    boost: false,
  };
}

/** Everything the simulation tracks about one craft. */
export interface EntityState {
  id: number;
  team: Team;
  pos: Vec3;
  vel: Vec3;
  aimYaw: number;
  aimPitch: number;
  hp: number;
  /** Boost gauge, 0..config.flight.boostCapacity. */
  boostFuel: number;
  /** True while boost thrust is actually being applied this tick. */
  boosting: boolean;
  /** Seconds of remaining control lock-out after a crash. */
  stunTimer: number;
  /** Gun heat in shots, 0..loadout.heatCapacity. */
  heat: number;
  /** True while the gun is locked out cooling off. */
  overheated: boolean;
  /** Seconds left of the forced overheat cool-down. */
  cooldownRemaining: number;
  /** Seconds until the next shot is allowed. */
  fireCooldown: number;
  /** Seconds since the last shot, which gates heat decay. */
  sinceLastShot: number;
  /** Seconds of remaining damage immunity after being hit. */
  invulnTimer: number;
  /** Bolts fired this round, for the result screen and phase 5's player model. */
  shotsFired: number;
  shotsHit: number;
  alive: boolean;
}

/**
 * A bolt in flight.
 *
 * The gun fires travelling projectiles rather than resolving instantly, so
 * distance costs accuracy: at 120 m a bolt takes long enough to arrive that a
 * craft which changes course in the meantime is simply missed. That is what
 * makes leading a target (DESIGN.md 7.1's 偏差射撃) a real skill rather than a
 * cosmetic detail, and what gives an evading runner something to gain by
 * moving unpredictably.
 */
export interface ProjectileState {
  id: number;
  /** Entity that fired it. Bolts never hit their owner. */
  ownerId: number;
  team: Team;
  pos: Vec3;
  /** Constant: bolts fly straight and do not drop. */
  vel: Vec3;
  /** Seconds of flight left before it fizzles out at maximum range. */
  life: number;
  damage: number;
}

/** What killed or hurt a craft. */
export type DamageCause = 'beam' | 'collision';

/** Emitted on the tick a craft slams into geometry. Consumed by render/audio. */
export interface CollisionEvent {
  type: 'collision';
  entityId: number;
  pos: Vec3;
  /** Speed along the impact normal, m/s. */
  impactSpeed: number;
  normal: Vec3;
  damage: number;
}

/** A bolt left the muzzle. For the flash and the sound. */
export interface FireEvent {
  type: 'fire';
  shooterId: number;
  projectileId: number;
  origin: Vec3;
  dir: Vec3;
}

/**
 * A bolt stopped flying: it struck a craft, struck geometry, or ran out of
 * range. `hitEntityId` is null for anything that is not a craft.
 */
export interface ProjectileHitEvent {
  type: 'projectileHit';
  projectileId: number;
  ownerId: number;
  pos: Vec3;
  hitEntityId: number | null;
  /** True when the bolt simply expired at maximum range. */
  expired: boolean;
}

export interface DamageEvent {
  type: 'damage';
  targetId: number;
  /** The entity responsible, or null for self-inflicted crash damage. */
  sourceId: number | null;
  amount: number;
  cause: DamageCause;
  remainingHp: number;
  pos: Vec3;
}

export interface DeathEvent {
  type: 'death';
  entityId: number;
  killerId: number | null;
  pos: Vec3;
}

/** The gun hit its heat limit and is locked out for `cooldownTime`. */
export interface OverheatEvent {
  type: 'overheat';
  entityId: number;
}

/** The hunter got within `rules.touchRadius` of the runner. */
export interface TouchEvent {
  type: 'touch';
  hunterId: number;
  runnerId: number;
  pos: Vec3;
}

export type SimEvent =
  | CollisionEvent
  | FireEvent
  | ProjectileHitEvent
  | DamageEvent
  | DeathEvent
  | OverheatEvent
  | TouchEvent;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const cloneVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
