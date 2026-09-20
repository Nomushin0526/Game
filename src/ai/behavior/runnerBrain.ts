/**
 * The runner's behaviours (DESIGN.md 7.1).
 *
 * The runner wins by being alive when the clock stops, so survival outscores
 * everything and fighting only happens when it is clearly the better trade.
 */

import { distance } from '../../sim/math.ts';
import type { Vec3 } from '../../sim/types.ts';
import { aimPoint, canShoot, findClutter, findCover, findEscape, jink, sampleArena } from '../tactics.ts';
import { holdRange } from './hunterBrain.ts';
import type { Action, Brain, BrainContext, Intent } from '../types.ts';

/** Below this the hunter is close enough that only distance matters. */
const PANIC_RANGE = 45;
/** Minimum time the runner sticks with a chosen cover spot, seconds. */
const COVER_COMMIT_SECONDS = 3.5;

/**
 * Where a fleeing runner points its nose.
 *
 * Keeping the hunter in the field of view is what keeps `Perception` alive: a
 * runner that stares at its destination loses sight within a tick, stops
 * updating its threat estimate, and then quietly stops boosting and dies. The
 * craft can thrust in any direction regardless of where it is looking, so
 * watching your pursuer costs nothing but the risk of flying into something —
 * and obstacle avoidance in the controller covers that.
 */
function watchThreat(ctx: BrainContext, fallback: Vec3): Vec3 {
  return ctx.estimate ?? fallback;
}

/**
 * Put distance between yourself and the hunter, fast.
 *
 * The four runner behaviours are scored so they do not overlap, keyed on
 * distance: inside tag range nothing matters but getting away, inside its own
 * weapon range it retreats shooting, beyond that it breaks line of sight, and
 * with no contact at all it goes to ground. Overlapping bands are what had the
 * runner flip-flopping between fleeing and hiding and never firing a shot.
 */
const evade: Action = {
  name: 'evade',
  score(ctx) {
    // With no idea where the hunter is there is nothing to run *from*;
    // `hide` takes over and heads for clutter instead.
    if (!ctx.estimate) return 0.1;
    // A hunter this close is one good burst from a tag, which ends the round.
    if (ctx.range < PANIC_RANGE) return 0.95;
    return 0.3 + (1 - Math.min(1, ctx.range / 140)) * 0.2;
  },
  act(ctx): Intent {
    const threat = ctx.estimate ?? ctx.perception.lastSeen?.pos ?? sampleArena(ctx);
    const target = ctx.memory.escapeTarget;
    // Re-pick on arrival, or when the run no longer actually leads away because
    // the hunter has cut the corner.
    const stale =
      !target ||
      distance(ctx.self.pos, target) < 20 ||
      (ctx.decisionTick && distance(target, threat) < distance(ctx.self.pos, threat));
    if (stale) ctx.memory.escapeTarget = findEscape(ctx, threat, 110);

    return {
      moveTo: jink(ctx, ctx.nav.steer(ctx.self.pos, ctx.memory.escapeTarget!, ctx.dt), threat),
      lookAt: watchThreat(ctx, ctx.memory.escapeTarget!),
      fire: false,
      boost: true,
    };
  },
};

/** Break line of sight and stay broken. */
const hide: Action = {
  name: 'hide',
  score(ctx) {
    // Unfound is the runner's best state, and the way to stay there is to be
    // somewhere cluttered rather than somewhere open.
    if (!ctx.perception.hasMemory(ctx.config)) return 0.45;
    if (ctx.range < PANIC_RANGE) return 0;
    const health = ctx.self.hp / ctx.config.loadout[ctx.self.team].maxHp;
    // Being seen is the emergency: the hunter out-ranges and out-damages this
    // craft, so every second in the open is health it cannot afford.
    const exposed = ctx.perception.visible ? 0.45 : 0.25;
    return 0.3 + (1 - health) * 0.2 + exposed;
  },
  act(ctx): Intent {
    const threat = ctx.estimate ?? ctx.perception.lastSeen?.pos;
    if (!threat) return goToGround(ctx);

    const spot = ctx.memory.coverSpot;
    // A hidden spot is only hidden relative to where the hunter is now, so it
    // is dropped once the hunter flies around the building. A spot chosen
    // merely as "the cluttered direction" was never hidden and is committed to
    // until reached — re-rolling that every decision tick made the runner
    // oscillate on the spot instead of getting anywhere.
    const stale =
      !spot ||
      distance(ctx.self.pos, spot) < 12 ||
      (ctx.decisionTick &&
        ctx.memory.coverCommit <= 0 &&
        ctx.memory.coverIsHidden &&
        !ctx.physics.isBlocked(spot, threat));
    if (stale) {
      const choice = findCover(ctx, threat, 90);
      ctx.memory.coverSpot = choice?.pos ?? findEscape(ctx, threat, 90);
      ctx.memory.coverIsHidden = choice?.hidden ?? false;
      // Long enough to actually fly there; cover across the map is no use if
      // it is abandoned two ticks after being chosen.
      ctx.memory.coverCommit = COVER_COMMIT_SECONDS;
    }

    return {
      moveTo: jink(ctx, ctx.nav.steer(ctx.self.pos, ctx.memory.coverSpot!, ctx.dt), threat),
      lookAt: watchThreat(ctx, ctx.memory.coverSpot!),
      fire: false,
      // Reaching cover before the hunter closes is the whole move, so spend
      // the gauge whenever the hunter is anywhere in mind, not just in sight.
      boost: ctx.perception.hasMemory(ctx.config),
    };
  },
};

/** Turn and fight, but only when the hunter is nearly down. */
const fight: Action = {
  name: 'fight',
  score(ctx) {
    if (!ctx.perception.acquired || !ctx.enemy) return 0;
    const enemyHealth = ctx.enemy.hp / ctx.config.loadout[ctx.enemy.team].maxHp;
    const ownHealth = ctx.self.hp / ctx.config.loadout[ctx.self.team].maxHp;
    // A knockout ends the round in the runner's favour immediately, so a nearly
    // dead hunter is worth the risk. Otherwise this stays well below evading.
    if (enemyHealth > 0.35 || ownHealth < enemyHealth) return 0;
    return 0.5 + (1 - enemyHealth) * 0.4;
  },
  act(ctx): Intent {
    const enemy = ctx.enemy;
    if (!enemy) return goToGround(ctx);

    const shootAt = aimPoint(ctx.self, enemy, ctx.tuning, ctx.config);
    return {
      moveTo: ctx.nav.steer(ctx.self.pos, holdRange(ctx, enemy.pos, ctx.tuning.preferredRange), ctx.dt),
      lookAt: shootAt,
      fire: ctx.perception.acquired && canShoot(ctx, shootAt),
      boost: false,
    };
  },
};

/** Retreat while shooting back over your shoulder. */
const kite: Action = {
  name: 'kite',
  score(ctx) {
    if (!ctx.perception.acquired || !ctx.enemy) return 0;
    if (ctx.range < PANIC_RANGE) return 0;
    // Only worth it inside its own weapon range. Beyond that it would be
    // retreating without being able to shoot, which is just `hide` with the
    // trigger held.
    if (ctx.range > ctx.config.loadout[ctx.self.team].range) return 0;
    // Retreating while shooting is strictly better than retreating silently:
    // the movement is the same and the hunter has to respect the return fire.
    const band = 1 - Math.min(1, Math.abs(ctx.range - ctx.tuning.preferredRange) / 60);
    return 0.8 + band * 0.1;
  },
  act(ctx): Intent {
    const enemy = ctx.enemy;
    if (!enemy) return goToGround(ctx);

    const shootAt = aimPoint(ctx.self, enemy, ctx.tuning, ctx.config);
    if (!ctx.memory.escapeTarget || distance(ctx.self.pos, ctx.memory.escapeTarget) < 25) {
      ctx.memory.escapeTarget = findEscape(ctx, enemy.pos, 100);
    }

    return {
      // Flying away while aiming back is exactly what the local move frame
      // is for: the controller resolves it into reverse thrust.
      moveTo: jink(ctx, ctx.nav.steer(ctx.self.pos, ctx.memory.escapeTarget, ctx.dt), enemy.pos),
      lookAt: shootAt,
      fire: ctx.perception.acquired && canShoot(ctx, shootAt),
      boost: true,
    };
  },
};

/** No contact: settle into the most cluttered ground nearby and stay put-ish. */
function goToGround(ctx: BrainContext): Intent {
  if (!ctx.memory.coverSpot || distance(ctx.self.pos, ctx.memory.coverSpot) < 15) {
    ctx.memory.coverSpot = findClutter(ctx, 90);
    ctx.memory.coverIsHidden = false;
    ctx.memory.coverCommit = COVER_COMMIT_SECONDS;
  }
  return {
    moveTo: ctx.nav.steer(ctx.self.pos, ctx.memory.coverSpot, ctx.dt),
    lookAt: null,
    fire: false,
    // No threat in sight is exactly when the gauge should be refilling.
    boost: false,
  };
}

export const runnerBrain: Brain = { actions: [evade, hide, fight, kite] };
