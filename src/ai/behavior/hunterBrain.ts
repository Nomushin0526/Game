/**
 * The hunter's behaviours (DESIGN.md 7.1).
 *
 * The hunter is on the clock: it loses the round if it does not land the kill
 * or the tag, so every score here is biased towards pressure. Scores are all on
 * a rough 0..1 scale so `actionHysteresis` means the same thing to each of them.
 */

import { add, distance, normalize, scale, sub } from '../../sim/math.ts';
import type { Vec3 } from '../../sim/types.ts';
import { canShoot, findCover, sampleArena, searchPoint, shotTarget } from '../tactics.ts';
import type { Action, Brain, BrainContext, Intent } from '../types.ts';

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

/** Chase the enemy down and go for the tag. */
const pursue: Action = {
  name: 'pursue',
  score(ctx) {
    if (!ctx.estimate) return 0;
    const closeness = 1 - Math.min(1, ctx.range / 160);
    // Committing hard once inside tag range is what wins rounds.
    const commit = ctx.range < TAG_COMMIT_RANGE ? 0.45 : 0;
    return 0.35 + closeness * 0.35 + commit + ctx.perception.confidence(ctx.config) * 0.15;
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
      boost: ctx.range > 18,
    };
  },
};

/** Hold a working distance and shoot, rather than diving into every fight. */
const duel: Action = {
  name: 'duel',
  score(ctx) {
    if (!ctx.perception.acquired || !ctx.enemy) return 0;
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
    const expected = bestGuess(ctx);
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

export const hunterBrain: Brain = { actions: [pursue, duel, search, ambush] };

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
