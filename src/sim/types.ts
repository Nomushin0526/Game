/**
 * Core value types shared by the simulation.
 *
 * Nothing in `src/sim/` may import from `src/render/`, `src/input/` or `three`.
 * The simulation has to stay runnable head-less under plain Node.js.
 */

import type { ItemKind } from './config.ts';

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
  /**
   * Item slot to use this tick, or -1 for none.
   *
   * Edge-triggered by whoever produces the input: a source holds the index for
   * exactly one tick per press. Holding the key down does not spend the next
   * charge the moment the cooldown expires.
   */
  useItem: number;
}

export function neutralInput(): PlayerInput {
  return {
    move: { x: 0, y: 0, z: 0 },
    aimYaw: 0,
    aimPitch: 0,
    fire: false,
    boost: false,
    useItem: NO_ITEM,
  };
}

/** `PlayerInput.useItem` value meaning "not using anything this tick". */
export const NO_ITEM = -1;

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
  /** Bolts left for the round. At zero the gun is dry until the next round. */
  ammo: number;
  /** Seconds since the last shot, which gates heat decay. */
  sinceLastShot: number;
  /** Seconds of remaining damage immunity after being hit. */
  invulnTimer: number;
  /** Consumables carried this round, in slot order. */
  items: ItemSlotState[];
  /** Seconds of shield left. Beam damage is soaked while this is positive. */
  shieldTimer: number;
  /** Damage the current shield can still soak before it breaks early. */
  shieldPool: number;
  /** Seconds left blinded by a flash. Perception is dead while positive. */
  blindTimer: number;
  /**
   * Seconds left of an active scan.
   *
   * While positive the craft tracks the real enemy by instrument: decoys are
   * ignored, cover does not hide it, and a flash does not take it away. Only
   * the range limit in `items.scan.radius` still applies.
   */
  revealTimer: number;
  /** Seconds left slowed by a snare. Cuts top speed, not acceleration. */
  snareTimer: number;
  /** Seconds left of an overdrive surge: faster, and boost costs nothing. */
  overdriveTimer: number;
  /** Bolts fired this round, for the result screen and phase 5's player model. */
  shotsFired: number;
  shotsHit: number;
  alive: boolean;
}

/** One item slot: what it is, how many uses are left, and whether it is ready. */
export interface ItemSlotState {
  kind: ItemKind;
  charges: number;
  /** Seconds until the slot is usable again. */
  cooldown: number;
}

/**
 * A phantom craft, thrown to be chased.
 *
 * It is not an entity: it cannot be hit for damage, cannot shoot and cannot
 * win a round. It exists purely to be mistaken for its owner by whatever is
 * looking — which for the CPU means `Perception`, and for a human means their
 * own eyes.
 */
export interface DecoyState {
  id: number;
  ownerId: number;
  team: Team;
  pos: Vec3;
  vel: Vec3;
  /** Seconds of life left. */
  life: number;
}

/**
 * What a projectile is for.
 *
 * Neither `flash` nor `snare` carries damage; both burst in a radius, on
 * contact or when the fuse runs out, whichever comes first.
 */
export type ProjectileKind = 'bolt' | 'flash' | 'snare';

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
  kind: ProjectileKind;
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

/** A craft spent a charge. */
export interface ItemUsedEvent {
  type: 'itemUsed';
  entityId: number;
  kind: ItemKind;
  pos: Vec3;
}

/** A flash grenade went off. */
export interface FlashBurstEvent {
  type: 'flashBurst';
  projectileId: number;
  ownerId: number;
  pos: Vec3;
  radius: number;
}

export interface BlindedEvent {
  type: 'blinded';
  entityId: number;
  duration: number;
}

/** A snare charge went off. */
export interface SnareBurstEvent {
  type: 'snareBurst';
  projectileId: number;
  ownerId: number;
  pos: Vec3;
  radius: number;
}

export interface SnaredEvent {
  type: 'snared';
  entityId: number;
  duration: number;
}

/** A shield took a hit meant for its owner. */
export interface ShieldAbsorbedEvent {
  type: 'shieldAbsorbed';
  entityId: number;
  amount: number;
  /** True when this hit used the shield up. */
  broke: boolean;
  pos: Vec3;
}

/** A decoy expired, or was shot and popped. */
export interface DecoyGoneEvent {
  type: 'decoyGone';
  decoyId: number;
  pos: Vec3;
  popped: boolean;
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
  | ItemUsedEvent
  | FlashBurstEvent
  | BlindedEvent
  | SnareBurstEvent
  | SnaredEvent
  | DecoyGoneEvent
  | ShieldAbsorbedEvent
  | TouchEvent;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const cloneVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
