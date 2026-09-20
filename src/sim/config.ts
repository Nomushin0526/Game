/**
 * Every number that affects game balance lives here. Nothing in the rest of the
 * codebase may hard-code a balance value; read it from `CONFIG` (or from a
 * config passed into the `World`) instead.
 *
 * See DESIGN.md section 2.3 for the reasoning behind the starting values.
 */

import type { Team } from './types.ts';

/** Per-team tuning. The hunter wins by touch as well, so it hits softer. */
export interface LoadoutConfig {
  maxHp: number;
  /** Damage per beam hit. */
  damage: number;
  /** Seconds between shots. */
  fireInterval: number;
  /** Shots fired before the gun overheats. */
  heatCapacity: number;
  /** Seconds of forced cool-down once overheated. */
  cooldownTime: number;
  /** Hit-scan range in metres. */
  range: number;
  /** Level-flight speed in m/s. */
  cruiseSpeed: number;
  /** Speed multiplier while boosting. */
  boostMultiplier: number;
}

export interface FlightConfig {
  /** Collision radius of a craft, metres. */
  bodyRadius: number;
  /** Acceleration towards the requested velocity, m/s^2. */
  accel: number;
  /** Deceleration when the stick is released, m/s^2. */
  decel: number;
  /** Extra acceleration applied while boosting, m/s^2. */
  boostAccel: number;
  boostCapacity: number;
  /** Gauge units drained per second of boost. */
  boostDrain: number;
  /** Gauge units regained per second when not boosting. */
  boostRegen: number;
  /** Boost cannot start again below this gauge value (anti-stutter). */
  boostMinToEngage: number;
  /** Pitch clamp in radians (+/-). */
  maxPitch: number;
  /** Impacts slower than this are silent scrapes: no damage, no stun. */
  minImpactSpeed: number;
  /** HP lost on a crash. */
  collisionDamage: number;
  /** Seconds of lost control after a crash. */
  collisionStun: number;
  /** Fraction of velocity kept after a crash (0 = dead stop). */
  collisionRestitution: number;
  /** Gap kept between the hull and geometry so casts never start embedded. */
  skinWidth: number;
}

export interface ArenaConfig {
  /** Playfield extent on X, metres (centred on the origin). */
  sizeX: number;
  /** Playfield extent on Z, metres (centred on the origin). */
  sizeZ: number;
  /** Invisible ceiling, metres. */
  ceiling: number;
  /** Ground plane height, metres. */
  floor: number;
}

export interface RulesConfig {
  /** Round length in seconds. */
  timeLimit: number;
  /** Who takes the round when the clock runs out. */
  timeoutWinner: 'runner' | 'draw';
  /** Centre-to-centre distance at which the hunter tags the runner. */
  touchRadius: number;
  /** Rounds needed to take the match (best of 2n-1). */
  roundsToWin: number;
  /** Swap hunter/runner between rounds. */
  swapSidesEachRound: boolean;
  /** Seconds of countdown before control unlocks. */
  countdown: number;
  /** Minimum distance between the two spawn points, metres. */
  minSpawnDistance: number;
  /** Seconds of damage immunity after being hit (0 disables). */
  hitInvulnerability: number;
}

export interface InputConfig {
  /** Mouse radians per pixel of movement. */
  mouseSensitivity: number;
  /** Gamepad stick radians per second at full deflection. */
  stickSensitivity: number;
  gamepadDeadzone: number;
  aimAssistEnabled: boolean;
  /** Half-angle of the aim-assist cone, radians. */
  aimAssistConeRad: number;
  /** Fraction of the remaining angular error closed per second. */
  aimAssistStrength: number;
}

export interface SimConfig {
  /** Fixed simulation rate. Never step the world at anything else. */
  tickRate: number;
  fixedDt: number;
  /** Default RNG seed when a caller does not supply one. */
  defaultSeed: number;
}

export interface SkyTagConfig {
  sim: SimConfig;
  arena: ArenaConfig;
  flight: FlightConfig;
  rules: RulesConfig;
  input: InputConfig;
  loadout: Record<Team, LoadoutConfig>;
}

export const CONFIG: SkyTagConfig = {
  sim: {
    tickRate: 60,
    fixedDt: 1 / 60,
    defaultSeed: 1,
  },
  arena: {
    sizeX: 400,
    sizeZ: 400,
    ceiling: 150,
    floor: 0,
  },
  flight: {
    bodyRadius: 1.2,
    accel: 45,
    decel: 30,
    boostAccel: 25,
    boostCapacity: 100,
    boostDrain: 30,
    boostRegen: 15,
    boostMinToEngage: 10,
    maxPitch: (80 * Math.PI) / 180,
    minImpactSpeed: 6,
    collisionDamage: 5,
    collisionStun: 0.5,
    collisionRestitution: 0,
    skinWidth: 0.05,
  },
  rules: {
    timeLimit: 180,
    // DESIGN.md section 10: the hunter has two win conditions, so the runner
    // takes the clock. Flip to 'draw' to play the original rule set.
    timeoutWinner: 'runner',
    touchRadius: 1.8,
    roundsToWin: 2,
    swapSidesEachRound: true,
    countdown: 3,
    minSpawnDistance: 150,
    hitInvulnerability: 0,
  },
  input: {
    mouseSensitivity: 0.0022,
    stickSensitivity: 2.8,
    gamepadDeadzone: 0.15,
    aimAssistEnabled: true,
    aimAssistConeRad: (5 * Math.PI) / 180,
    aimAssistStrength: 3.0,
  },
  loadout: {
    hunter: {
      maxHp: 100,
      damage: 8,
      fireInterval: 0.2,
      heatCapacity: 20,
      cooldownTime: 3,
      range: 120,
      cruiseSpeed: 22,
      boostMultiplier: 1.8,
    },
    runner: {
      maxHp: 100,
      damage: 10,
      fireInterval: 0.2,
      heatCapacity: 20,
      cooldownTime: 3,
      range: 120,
      cruiseSpeed: 22,
      boostMultiplier: 2.0,
    },
  },
};

/** Deep copy, so batch runs and tests can tweak numbers without leaking state. */
export function cloneConfig(base: SkyTagConfig = CONFIG): SkyTagConfig {
  return structuredClone(base);
}
