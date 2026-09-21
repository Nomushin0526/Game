/**
 * The hunter's behaviours (DESIGN.md 7.1).
 *
 * The hunter is on the clock: it loses the round if it does not land the kill
 * or the tag, so every score here is biased towards pressure. Scores are all on
 * a rough 0..1 scale so `actionHysteresis` means the same thing to each of them.
 */

import { add, angleDelta, distance, lookAngles, normalize, scale, sub } from '../../sim/math.ts';
import { NO_ITEM, type Vec3 } from '../../sim/types.ts';
import { canShoot, findCover, sampleArena, searchPoint, shotTarget } from '../tactics.ts';
import { isDry, type Action, type Brain, type BrainContext, type Intent, type ItemChoice } from '../types.ts';

/** Distance at which the hunter commits to a tag instead of shooting. */
const TAG_COMMIT_RANGE = 26;

/**
 * Somewhere to head for, whatever the AI currently knows.
 *
 * `ctx.estimate` goes null the moment the memory of a sighting expires, which
 * can happen on any tick — including one where a chase was chosen 0.3 s ago
 * and is still running.
 */
function bestGuess(ctx: BrainContext): Vec3 {
  return ctx.estimate ?? ctx.perception.lastSeen?.pos ?? sampleArena(ctx);
}

/**
 * The haunt worth waiting at, or null.
 *
 * Only the nearest one: an ambush is only an ambush if you are set up before
 * they arrive, and flying across the map to a slightly more popular area
 * spends the very time the trap was supposed to save.
 */
function learnedAmbushSpot(ctx: BrainContext): Vec3 | null {
  const haunts = ctx.opponent?.haunts(4) ?? [];
  if (haunts.length === 0) return null;

  let best: Vec3 | null = null;
  let bestDistance = Infinity;
  for (const spot of haunts) {
    const range = distance(ctx.self.pos, spot);
    if (range < bestDistance) {
      bestDistance = range;
      best = spot;
    }
  }
  return best;
}

/** Chase the enemy down and go for the tag. */
const pursue: Action = {
  name: 'pursue',
  score(ctx) {
    if (!ctx.estimate) return 0;
    const closeness = 1 - Math.min(1, ctx.range / 160);
    // Committing hard once inside tag range is what wins rounds.
    const commit = ctx.range < TAG_COMMIT_RANGE ? 0.45 : 0;
    // Out of bolts, the tag is the only ending the hunter can still reach, so
    // it stops looking for a firing position and just chases.
    const dry = isDry(ctx.self) ? 0.5 : 0;
    return 0.35 + closeness * 0.35 + commit + dry + ctx.perception.confidence(ctx.config) * 0.15;
  },
  act(ctx): Intent {
    const target = bestGuess(ctx);
    const goal = ctx.nav.steer(ctx.self.pos, target, ctx.dt);
    const shootAt = (ctx.perception.acquired ? shotTarget(ctx) : null) ?? target;

    return {
      moveTo: goal,
      lookAt: shootAt,
      // Firing while closing is free: the tag is the real threat.
      fire: ctx.perception.acquired && canShoot(ctx, shootAt),
      // A dry hunter has to actually arrive, so it keeps the boost on right
      // up to contact rather than easing off at the usual stand-off distance.
      boost: ctx.range > 18 || isDry(ctx.self),
    };
  },
};

/** Hold a working distance and shoot, rather than diving into every fight. */
const duel: Action = {
  name: 'duel',
  score(ctx) {
    if (!ctx.perception.acquired || !ctx.enemy) return 0;
    // Holding a firing distance with nothing to fire is just letting the clock
    // run, which the hunter loses.
    if (isDry(ctx.self)) return 0;
    // Best when already near the preferred range and healthy enough to trade.
    const band = 1 - Math.min(1, Math.abs(ctx.range - ctx.tuning.preferredRange) / 70);
    const health = ctx.self.hp / ctx.config.loadout[ctx.self.team].maxHp;
    // Never duel when a tag is on: closing wins the round outright.
    if (ctx.range < TAG_COMMIT_RANGE) return 0;
    return 0.3 + band * 0.4 + health * 0.2;
  },
  act(ctx): Intent {
    const enemy = ctx.enemy;
    const shootAt = shotTarget(ctx);
    if (!enemy || !shootAt) return { moveTo: bestGuess(ctx), lookAt: null, fire: false, boost: false };

    // Hold range against what it believes it is fighting, decoy or not.
    const hold = holdRange(ctx, ctx.estimate ?? enemy.pos, ctx.tuning.preferredRange);

    return {
      moveTo: ctx.nav.steer(ctx.self.pos, hold, ctx.dt),
      lookAt: shootAt,
      fire: ctx.perception.acquired && canShoot(ctx, shootAt),
      boost: ctx.self.overheated,
    };
  },
};

/** Sweep the area the enemy was last seen in. */
const search: Action = {
  name: 'search',
  score(ctx) {
    if (ctx.perception.visible) return 0;
    // Strongest right after losing them, fading as the trail goes cold.
    const freshness = ctx.perception.confidence(ctx.config);
    return 0.25 + freshness * 0.35;
  },
  act(ctx): Intent {
    const target = ctx.memory.searchTarget ?? searchPoint(ctx, 55);
    ctx.memory.searchTarget = distance(ctx.self.pos, target) < 14 ? null : target;

    return {
      moveTo: ctx.nav.steer(ctx.self.pos, target, ctx.dt),
      lookAt: null,
      fire: false,
      boost: true,
    };
  },
};

/**
 * Sit in cover near where the enemy is expected and wait.
 * Only worth it when the trail is warm; otherwise it is standing still while
 * the clock runs down, which loses.
 */
const ambush: Action = {
  name: 'ambush',
  score(ctx) {
    if (ctx.perception.visible || !ctx.perception.hasMemory(ctx.config)) return 0;
    const health = ctx.self.hp / ctx.config.loadout[ctx.self.team].maxHp;
    const timePressure = ctx.timeRemaining / ctx.config.rules.timeLimit;
    // Hurt hunters with time left can afford to set a trap; desperate ones cannot.
    return 0.2 + (1 - health) * 0.35 + timePressure * 0.2;
  },
  act(ctx): Intent {
    // Wait where they usually turn up rather than where they were last seen,
    // once there is enough of a habit to bet a trap on (DESIGN.md 7.2).
    const expected = learnedAmbushSpot(ctx) ?? bestGuess(ctx);
    if (!ctx.memory.ambushSpot || (ctx.decisionTick && distance(ctx.self.pos, ctx.memory.ambushSpot) < 8)) {
      ctx.memory.ambushSpot = findCover(ctx, expected, 60)?.pos ?? expected;
    }
    const spot = ctx.memory.ambushSpot;

    return {
      moveTo: ctx.nav.steer(ctx.self.pos, spot, ctx.dt),
      // Watch the direction they are expected from.
      lookAt: expected,
      fire: false,
      boost: distance(ctx.self.pos, spot) > 40,
    };
  },
};

/**
 * When to spend a charge.
 *
 * The mirror of the runner's rule, and ordered the same way, by urgency. The
 * ordering encodes what the kit is for: find them first, because nothing else
 * works on a contact you do not have; then take their speed; then spend your
 * own. A scan into empty air or an overdrive at 150 m is a wasted round.
 */
function chooseItem(ctx: BrainContext): ItemChoice {
  const ready = (kind: 'scan' | 'snare' | 'overdrive' | 'overcharge'): number =>
    ctx.self.items.findIndex((slot) => slot.kind === kind && slot.charges > 0 && slot.cooldown <= 0);

  const items = ctx.config.items;
  const self = ctx.self;

  // Scan: the answer to every way the runner can take the contact away — a
  // decoy being chased, a flash in the face, or a craft that has just gone
  // behind a building. Needs somewhere to look, so a cold trail does not
  // trigger it: a ping finds nothing at 200 m either.
  const scan = ready('scan');
  if (scan >= 0 && self.revealTimer <= 0) {
    const lost = !ctx.perception.visible && ctx.perception.hasMemory(ctx.config);
    if ((ctx.perception.fooled || self.blindTimer > 0 || lost) && ctx.range < items.scan.radius) {
      return scan;
    }
  }

  // Snare: thrown at something real, close enough that the lob arrives and
  // roughly in front. Against a decoy it would only slow a phantom.
  const snare = ready('snare');
  const enemy = ctx.enemy;
  if (snare >= 0 && enemy && !ctx.perception.fooled && ctx.perception.acquired) {
    const reach = items.snare.throwSpeed * items.snare.fuse;
    if (ctx.range < reach && enemy.snareTimer <= 0) {
      const desired = lookAngles(self.pos, enemy.pos);
      const offAim = Math.abs(angleDelta(self.aimYaw, desired.yaw));
      if (offAim < 0.4 && !ctx.physics.isBlocked(self.pos, enemy.pos)) return snare;
    }
  }

  // Overcharge: only ever worth it with a target in sight and the magazine
  // low enough that the free window is actually replacing bolts it does not
  // have. Spent while still well stocked it gives away a slot for nothing.
  const overcharge = ready('overcharge');
  if (
    overcharge >= 0 &&
    self.overchargeTimer <= 0 &&
    ctx.perception.acquired &&
    !ctx.perception.fooled &&
    self.ammo < ctx.config.loadout[self.team].ammo * 0.35 &&
    ctx.range < ctx.config.loadout[self.team].range
  ) {
    return overcharge;
  }

  // Overdrive: the closing move. Only once the tag is a realistic outcome of
  // the next few seconds, and only when there is something real to close on.
  const overdrive = ready('overdrive');
  if (
    overdrive >= 0 &&
    self.overdriveTimer <= 0 &&
    ctx.estimate &&
    !ctx.perception.fooled &&
    ctx.range < OVERDRIVE_RANGE
  ) {
    return overdrive;
  }

  return NO_ITEM;
}

/**
 * Distance inside which an overdrive is worth spending.
 *
 * Four seconds of surge covers something like 200 m, so anything under this is
 * closable; beyond it the charge runs out mid-chase and buys nothing.
 */
const OVERDRIVE_RANGE = 110;

export const hunterBrain: Brain = { actions: [pursue, duel, search, ambush], chooseItem };

/**
 * A point at `range` from the target, on the side the craft is already on.
 * Keeps the fight at a chosen distance without orbiting mechanically.
 */
export function holdRange(ctx: BrainContext, target: Vec3, range: number): Vec3 {
  const away = sub(ctx.self.pos, target);
  const currentRange = Math.hypot(away.x, away.y, away.z);
  if (currentRange < 1e-3) return add(target, { x: range, y: 0, z: 0 });

  const direction = scale(away, 1 / currentRange);
  // Drift sideways as well, so holding distance still presents a moving target.
  const side = normalize({ x: -direction.z, y: 0, z: direction.x });
  const strafe = scale(side, range * 0.35 * (ctx.self.id % 2 === 0 ? 1 : -1));
  return add(add(target, scale(direction, range)), strafe);
}
