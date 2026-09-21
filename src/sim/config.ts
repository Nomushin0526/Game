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
  /**
   * Bolts carried for the whole round. Not a magazine -- there is no reload.
   *
   * Heat caps how fast you may shoot; this caps how much shooting the round
   * contains at all. It exists to put the tag back on the table: a hunter that
   * can always shoot never has a reason to close to `rules.touchRadius`, and
   * measurement bore that out (tag decided 5-7% of rounds). A dry gun leaves
   * only the two endings the game is named after.
   */
  ammo: number;
  /** Seconds of forced cool-down once overheated. */
  cooldownTime: number;
  /** Maximum distance a bolt travels before it fizzles out, metres. */
  range: number;
  /**
   * Bolt speed, metres per second.
   *
   * The ratio of this to craft speed is what decides how much distance costs
   * accuracy, and before the runner had items it was the only setting that
   * moved the balance at all — see README.md. Giving the runner a way to break
   * contact bought back roughly 25 points of bolt speed: at 90 m/s a bolt
   * outruns a boosting craft about twofold and still reads as fast, where the
   * balance previously demanded 65 and a bolt you could nearly keep pace with.
   *
   * Anything between about 90 and 105 measures the same once run-to-run noise
   * is accounted for; this is the middle of that range.
   */
  projectileSpeed: number;
  /** Level-flight speed in m/s. */
  cruiseSpeed: number;
  /**
   * Acceleration towards the requested velocity, m/s^2 — per side, because
   * this is agility, and agility is not symmetric in a chase.
   *
   * Measured: the pursuer only has to point at the target, while the evader
   * has to change course faster than the pursuer can follow. Cutting it for
   * both sides took the hunter from 77% to 98% in a no-gun test, so this is
   * the evader's dial, not a shared one. `flight.accel` is the fallback for
   * anything that does not set it.
   */
  accel: number;
  /** Speed multiplier while boosting. */
  boostMultiplier: number;
  /** Gauge units drained per second of boost. */
  boostDrain: number;
  /** Gauge units regained per second when not boosting. */
  boostRegen: number;
}

/**
 * Consumables a craft carries into a round (DESIGN.md has none of these yet).
 *
 * The two kits answer each other. The runner's three deny the hunter
 * information or time; the hunter's three take it back:
 * - `scan` beats `decoy` and `flash` -- it finds the real craft by instrument
 * - `snare` takes the runner's speed away, which is what it escapes with
 * - `overdrive` gives the hunter speed, which is what it tags with
 */
export type ItemKind =
  | 'decoy' | 'shield' | 'flash'
  | 'scan' | 'snare' | 'overdrive'
  | 'overcharge';

interface ItemBase {
  /** Uses available per round. */
  charges: number;
  /** Seconds before the slot can be used again. */
  cooldown: number;
}

export interface DecoyConfig extends ItemBase {
  /** Seconds the phantom persists before fading out. */
  duration: number;
  /** Fraction of the thrower's velocity the decoy sets off with. */
  inheritVelocity: number;
  /** Speed it flies at when the thrower was barely moving, m/s. */
  minSpeed: number;
  /** A bolt that reaches a decoy pops it; this is its hittable radius. */
  hitRadius: number;
}

export interface ShieldConfig extends ItemBase {
  /** Seconds of protection. */
  duration: number;
  /**
   * Damage the shield can soak before it breaks early.
   * A pure timer would make the right play "pop it and ignore the fight";
   * a pool means a runner that stands and takes fire loses it anyway.
   */
  capacity: number;
}

export interface FlashConfig extends ItemBase {
  /** Seconds between the throw and the burst. */
  fuse: number;
  /** How fast it is lobbed, m/s. */
  throwSpeed: number;
  /** Blast radius, metres. */
  radius: number;
  /** Seconds the victim is blinded. */
  blindDuration: number;
}

export interface ScanConfig extends ItemBase {
  /** Seconds the true contact stays lit after the ping. */
  duration: number;
  /**
   * Metres. Beyond this the ping finds nothing, so it cannot be used to
   * re-acquire a runner that has genuinely got away -- only one that is hiding
   * nearby, behind a decoy, or behind a building.
   */
  radius: number;
}

export interface SnareConfig extends ItemBase {
  /** Seconds before it bursts of its own accord. */
  fuse: number;
  /** How fast it is lobbed, m/s. */
  throwSpeed: number;
  /** Burst radius, metres. Smaller than a flash: this one has to be aimed. */
  radius: number;
  /** Seconds the victim is slowed. */
  duration: number;
  /**
   * Speed multiplier applied to a snared craft.
   *
   * This is the hunter's tag tool: a runner at this fraction of its cruise
   * speed cannot out-run a hunter that was already faster, so closing to
   * `rules.touchRadius` stops being hopeless.
   */
  speedMultiplier: number;
}

export interface OverdriveConfig extends ItemBase {
  /** Seconds of surge. */
  duration: number;
  /** Speed multiplier stacked on top of boost. */
  speedMultiplier: number;
}

/**
 * A window in which shooting costs no ammunition.
 *
 * Only worth carrying because `loadout.ammo` made bolts scarce: it converts a
 * kit slot into the shooting the round no longer gives you for free, and it is
 * the one item both sides want for the same reason.
 */
export interface OverchargeConfig extends ItemBase {
  /** Seconds of free fire. */
  duration: number;
}

export interface ItemsConfig {
  /** Slot order per side. An empty list means that side carries nothing. */
  loadout: Record<Team, ItemKind[]>;
  decoy: DecoyConfig;
  shield: ShieldConfig;
  flash: FlashConfig;
  scan: ScanConfig;
  snare: SnareConfig;
  overdrive: OverdriveConfig;
  overcharge: OverchargeConfig;
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
  /** Default acceleration, m/s^2. A loadout's own `accel` overrides it. */
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
  /**
   * Mouse radians per pixel of movement.
   *
   * Started at 0.0022, which needs about 1,430 px of mouse travel to turn
   * around — three swipes of a pad, where a shooter usually wants 400-600 px.
   * Playtesting called this out as "cannot make sharp turns", and it was the
   * single most mechanical of the complaints: at that rate a hard turn is a
   * physical act, so nobody attempts one, so nothing feels fast.
   */
  mouseSensitivity: number;
  /**
   * Seconds within which a second tap of a movement key means "dash".
   *
   * Holding a modifier for boost works but occupies a finger that a flight
   * game wants for something else, and it separates "go fast" from "go this
   * way" when they are the same intention.
   */
  doubleTapWindow: number;
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
  /**
   * How lopsided the weave is, -1 (always breaks left) to 1 (always right).
   *
   * Zero is a pure sine, which is unbiased by construction and therefore has
   * no habit for phase 5's player model to find — measured, a CPU runner's
   * dodge lean came out at 0.03. Human players are not symmetric, so this
   * exists to give a CPU a comparable tell, and to make the learning testable
   * against an opponent that actually has one.
   */
  jinkBias: number;
  /** Weave cycles per second. Too fast and the craft makes no headway. */
  jinkRate: number;
  difficulty: Record<AiDifficulty, AiTuning>;
}

export interface HudConfig {
  /**
   * How much the radar tells you about the enemy (DESIGN.md section 10).
   * - `lineOfSight` paints a contact only while you can actually see it
   * - `always` is the arcade-style permanent contact
   * - `never` leaves you to find them by eye
   */
  enemyIndicator: 'lineOfSight' | 'always' | 'never';
  /**
   * Radar range in metres. Contacts beyond it are simply not painted, so the
   * radar has a real edge rather than pinning distant contacts to its rim.
   */
  radarRange: number;
  /**
   * Height difference at which a contact is marked as above or below, metres.
   * Below this it reads as level, which keeps the common case uncluttered.
   */
  radarAltitudeBand: number;
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
  items: ItemsConfig;
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
  items: {
    // Measured, not designed. `shield` and `overdrive` are still implemented
    // and still configurable — they just lost their slots once ammunition was
    // scarce. A damage soak is worth little when little damage is being dealt,
    // and a hunter that already has to close does not need help closing: the
    // same kit with `overdrive` in place of `snare` measured 41.7% with tag
    // wins at 28.3%, against 50.0% and 33.3% for this one.
    loadout: {
      hunter: ['scan', 'snare', 'overcharge'],
      runner: ['decoy', 'flash', 'overcharge'],
    },
    decoy: {
      charges: 2,
      cooldown: 12,
      duration: 8,
      inheritVelocity: 1,
      minSpeed: 18,
      hitRadius: 2.2,
    },
    shield: {
      charges: 2,
      cooldown: 16,
      duration: 4,
      capacity: 40,
    },
    flash: {
      charges: 2,
      cooldown: 14,
      fuse: 0.9,
      throwSpeed: 45,
      radius: 45,
      blindDuration: 2.2,
    },
    // One charge each against the runner's two. Measured: at two charges the
    // hunter won 68-85% of rounds, because the kit answers the runner's kit
    // and then the hunter still has the better gun. One charge is the version
    // that reads as "one shot at each answer" and measures in the target band.
    scan: {
      charges: 1,
      cooldown: 15,
      duration: 2.5,
      radius: 120,
    },
    snare: {
      charges: 1,
      cooldown: 18,
      fuse: 1.4,
      throwSpeed: 60,
      radius: 22,
      duration: 3,
      speedMultiplier: 0.55,
    },
    overdrive: {
      charges: 1,
      cooldown: 20,
      duration: 4,
      speedMultiplier: 1.18,
    },
    overcharge: {
      charges: 1,
      cooldown: 20,
      // Half the duration it started at. At 5 s it undid the thing that made
      // the tag work: the hunter ran dry in 50% of rounds instead of 80%, and
      // tag wins halved to 16.7%. A free-fire window has to be short enough
      // that it is a burst, not a refill.
      duration: 2.5,
    },
  },
  rules: {
    timeLimit: 180,
    // DESIGN.md section 10: the hunter has two win conditions, so the runner
    // takes the clock. Flip to 'draw' to play the original rule set.
    timeoutWinner: 'runner',
    // DESIGN.md asks for 1.8, which is about one body width: two craft have to
    // very nearly overlap. Measured, that made the tag unreachable — it
    // decided 5% of rounds. At 4 m it is a real target without being a free
    // one, and (with ammunition capped) it moved tag wins to 20-48%.
    touchRadius: 4,
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
    jinkBias: 0,
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
    // Comfortably past weapon range, so a contact shows up before it can shoot.
    radarRange: 200,
    radarAltitudeBand: 20,
    showEnemyHp: true,
  },
  input: {
    mouseSensitivity: 0.0052,
    doubleTapWindow: 0.28,
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
      // Cut from 12 when the hunter got its kit. It now has tools for closing,
      // so it no longer needs a gun that ends rounds on its own — and with
      // both kits in play, damage finally moved the win rate (it had been flat
      // across 12/10/8/6 before items existed). Still above the runner's 8,
      // and with the shorter fire interval the DPS gap is a third.
      damage: 9,
      fireInterval: 0.18,
      heatCapacity: 20,
      cooldownTime: 3,
      ammo: 60,
      range: 130,
      projectileSpeed: 95,
      cruiseSpeed: 25,
      accel: 45,
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
      ammo: 52,
      range: 110,
      projectileSpeed: 85,
      cruiseSpeed: 22,
      accel: 45,
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
