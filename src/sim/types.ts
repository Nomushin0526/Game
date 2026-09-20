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
  alive: boolean;
}

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

export type SimEvent = CollisionEvent;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const cloneVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
