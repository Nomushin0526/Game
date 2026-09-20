/**
 * Every number that affects game balance lives here. Nothing in the rest of the
 * codebase may hard-code a balance value; read it from `CONFIG` (or from a
 * config passed into the `World`) instead.
 *
 * See DESIGN.md section 2.3 for the reasoning behind the starting values.
 */

import type { Team } from './types.ts';

/**
 * Per-team tuning.
 *
 * The asymmetry is deliberate and is the opposite of DESIGN.md 2.3: the hunter
 * is faster and hits harder on every axis, and the runner's counterweight is
 * that surviving to the clock wins the round outright (`rules.timeoutWinner`).
 * The runner's edge is gauge economy, not raw speed: it drains boost slower and
 * refills it faster, so it can keep breaking line of sight while the hunter has
 * to spend its gauge to close the gap.
 */
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
  /** Maximum distance a bolt travels before it fizzles out, metres. */
  range: number;
  /**
   * Bolt speed, metres per second.
   *
   * The ratio of this to craft speed is what decides how much distance costs
   * accuracy, and it turned out to be the only setting that moves the balance
   * at all — see the measurements in README.md. These values put all three
   * difficulty tiers inside the design's 45-55% band. They are deliberately
   * low: a bolt outruns a cruising craft roughly threefold but a boosting one
   * only by a third, so shooting someone running flat out away from you is not
   * really on, and the chase has to do the work instead.
   */
  projectileSpeed: number;
  /** Level-flight speed in m/s. */
  cruiseSpeed: number;
  /** Speed multiplier while boosting. */
  boostMultiplier: number;
  /** Gauge units drained per second of boost. */
  boostDrain: number;
  /** Gauge units regained per second when not boosting. */
  boostRegen: number;
}

export interface WeaponConfig {
  /** Radius of the hittable sphere around a craft, metres. */
  hitRadius: number;
  /** Radius of a bolt, added to the target's hit radius on impact. */
  projectileRadius: number;
  /**
   * Heat bled off per second once the gun has been idle, in shots.
   *
   * DESIGN.md only specifies "20 shots then a 3 s cool-down". Without decay the
   * gun would be dead after 20 shots for the whole match, so heat recovers
   * between bursts and only a sustained burst overheats.
   */
  heatDecay: number;
  /**
   * Seconds since the last shot before heat starts bleeding off.
   *
   * Must be comfortably longer than any `fireInterval`, otherwise heat would
   * decay in the gaps inside a burst and a held trigger would never overheat.
   */
  heatDecayDelay: number;
  /** Metres ahead of the craft centre that a beam starts. Cosmetic. */
  muzzleOffset: number;
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
  /** Seconds the round result stays up before the next round starts. */
  roundIntermission: number;
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

/** Difficulty knobs from DESIGN.md 7.1: reaction, aim error, lead accuracy. */
export type AiDifficulty = 'easy' | 'normal' | 'hard';

export interface AiTuning {
  /** Seconds between the enemy becoming visible and the AI acting on it. */
  reactionTime: number;
  /** Spread of the random aim offset, radians. */
  aimError: number;
  /** How fast the AI can swing its aim, radians per second. */
  turnRate: number;
  /** 0..1 fraction of the correct lead applied when shooting a moving target. */
  leadAccuracy: number;
  /** 0..1 trigger discipline: how often it shoots when it legitimately could. */
  fireWillingness: number;
  /** Distance it tries to hold in a gunfight, metres. */
  preferredRange: number;
}

export interface AiConfig {
  /** Navigation voxel size, metres (DESIGN.md 7.1 specifies 4 m). */
  cellSize: number;
  /** Space kept clear around obstacles when marking voxels blocked, metres. */
  clearance: number;
  /** Total field of view, radians. Outside it the enemy is simply not seen. */
  fovRad: number;
  /**
   * How far the AI can pick a craft out, metres.
   *
   * Without a limit the CPU spots its opponent across the whole arena the
   * instant a round starts, which makes breaking contact impossible and the
   * runner's entire game unplayable. Set above weapon range so a duel is never
   * fought blind.
   */
  sightRange: number;
  /** Seconds a lost target's last known position is still worth chasing. */
  memoryDuration: number;
  /** Seconds between path recalculations. Pathfinding is the expensive part. */
  repathInterval: number;
  /** Seconds between utility re-evaluations. */
  decisionInterval: number;
  /** Score bonus for the action already running, so it cannot flip-flop. */
  actionHysteresis: number;
  /** Cap on A* node expansions per search, so one call cannot stall a tick. */
  maxPathNodes: number;
  /** Sideways amplitude of evasive weaving under fire, metres. */
  jinkAmplitude: number;
  /** Weave cycles per second. Too fast and the craft makes no headway. */
  jinkRate: number;
  difficulty: Record<AiDifficulty, AiTuning>;
}

export interface HudConfig {
  /**
   * How much the HUD tells you about the enemy (DESIGN.md section 10).
   * - `lineOfSight` only points at them while you can actually see them
   * - `always` is the arcade-style permanent arrow
   * - `never` leaves you to find them by eye
   */
  enemyIndicator: 'lineOfSight' | 'always' | 'never';
  /** Show the enemy's HP bar, not just your own. */
  showEnemyHp: boolean;
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
  weapon: WeaponConfig;
  rules: RulesConfig;
  input: InputConfig;
  hud: HudConfig;
  ai: AiConfig;
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
    boostMinToEngage: 10,
    maxPitch: (80 * Math.PI) / 180,
    minImpactSpeed: 6,
    collisionDamage: 5,
    collisionStun: 0.5,
    collisionRestitution: 0,
    skinWidth: 0.05,
  },
  weapon: {
    hitRadius: 1.8,
    projectileRadius: 0.5,
    heatDecay: 5,
    heatDecayDelay: 0.6,
    muzzleOffset: 2.2,
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
    roundIntermission: 4,
    minSpawnDistance: 150,
    hitInvulnerability: 0,
  },
  ai: {
    cellSize: 4,
    // Roughly two body radii: enough that a route down a street does not
    // scrape the buildings on either side, without writing the street off.
    clearance: 2.5,
    fovRad: (120 * Math.PI) / 180,
    sightRange: 190,
    memoryDuration: 8,
    repathInterval: 0.5,
    decisionInterval: 0.35,
    actionHysteresis: 0.12,
    maxPathNodes: 8000,
    jinkAmplitude: 26,
    jinkRate: 0.85,
    difficulty: {
      easy: {
        reactionTime: 0.6,
        aimError: 0.085,
        turnRate: 1.6,
        leadAccuracy: 0.2,
        fireWillingness: 0.55,
        preferredRange: 70,
      },
      normal: {
        reactionTime: 0.32,
        aimError: 0.042,
        turnRate: 2.6,
        leadAccuracy: 0.6,
        fireWillingness: 0.8,
        preferredRange: 60,
      },
      hard: {
        reactionTime: 0.15,
        aimError: 0.016,
        turnRate: 4.0,
        leadAccuracy: 0.95,
        fireWillingness: 0.95,
        preferredRange: 52,
      },
    },
  },
  hud: {
    // Hiding has to mean something in a game of tag, so the default is the
    // non-cheating one: no arrow through walls, for either side.
    enemyIndicator: 'lineOfSight',
    showEnemyHp: true,
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
    // The hunter out-guns and out-runs the runner on every axis. Its clock is
    // the pressure: it has `rules.timeLimit` seconds to land the kill or the tag.
    hunter: {
      maxHp: 100,
      damage: 12,
      fireInterval: 0.18,
      heatCapacity: 20,
      cooldownTime: 3,
      range: 130,
      projectileSpeed: 65,
      cruiseSpeed: 25,
      boostMultiplier: 1.95,
      boostDrain: 32,
      boostRegen: 14,
    },
    // The runner wins by staying alive, so it trades firepower and top speed
    // for a gauge that sustains repeated breaks of line of sight.
    runner: {
      maxHp: 100,
      damage: 8,
      fireInterval: 0.22,
      heatCapacity: 20,
      cooldownTime: 3,
      range: 110,
      projectileSpeed: 58,
      cruiseSpeed: 22,
      boostMultiplier: 1.85,
      boostDrain: 26,
      boostRegen: 19,
    },
  },
};

/** Deep copy, so batch runs and tests can tweak numbers without leaking state. */
export function cloneConfig(base: SkyTagConfig = CONFIG): SkyTagConfig {
  return structuredClone(base);
}
