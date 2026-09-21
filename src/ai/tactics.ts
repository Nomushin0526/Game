/**
 * Shared tactical helpers: picking cover, picking somewhere to run, and working
 * out where to aim at a moving target.
 *
 * Everything here samples candidate points and scores them. Sampling is driven
 * by the AI's seeded RNG, so two runs of the same match play out identically.
 */

import type { AiTuning, SkyTagConfig } from '../sim/config.ts';
import { add, distance, dot, forwardVector, normalize, rightVector, scale, sub } from '../sim/math.ts';
import { DODGE_ACT_THRESHOLD, type PlayerModel } from './learning/playerModel.ts';
import type { EntityState, Vec3 } from '../sim/types.ts';
import type { BrainContext } from './types.ts';

/** How far ahead of a target the AI is ever willing to aim, seconds. */
const MAX_LEAD_TIME = 1.5;

/**
 * Time for a bolt to reach a target that keeps its current velocity.
 *
 * Solves |r + u t| = v t for the earliest positive t, where r is the offset to
 * the target and u its velocity. Returns null when no bolt can catch it —
 * which is a real outcome when a boosting craft runs directly away.
 */
export function interceptTime(
  from: Vec3,
  target: Vec3,
  targetVel: Vec3,
  boltSpeed: number,
): number | null {
  const r = sub(target, from);
  const a = dot(targetVel, targetVel) - boltSpeed * boltSpeed;
  const b = 2 * dot(r, targetVel);
  const c = dot(r, r);

  // Target moving at exactly bolt speed degenerates to a linear equation.
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((t) => t > 0);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * Where to aim to hit a moving target.
 *
 * Bolts travel, so this is a genuine interception: aim where the target will be
 * when the bolt arrives, plus a little for the time it takes to swing the nose
 * onto that point. `leadAccuracy` scales how much of the correct lead is
 * actually applied, so a weak CPU shoots behind a crossing target and a strong
 * one does not — which is what makes the difficulty tiers mean something now
 * that distance costs accuracy.
 */
export function aimPoint(
  shooter: EntityState,
  target: EntityState,
  tuning: AiTuning,
  config: SkyTagConfig,
  model: PlayerModel | null = null,
): Vec3 {
  const toTarget = sub(target.pos, shooter.pos);
  const range = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
  if (range < 1e-3) return { ...target.pos };

  const boltSpeed = config.loadout[shooter.team].projectileSpeed;
  const flight = interceptTime(shooter.pos, target.pos, target.vel, boltSpeed);

  const forward = forwardVector(shooter.aimYaw, shooter.aimPitch);
  const cosAngle = Math.max(-1, Math.min(1, dot(forward, scale(toTarget, 1 / range))));
  const swing = Math.acos(cosAngle) / Math.max(tuning.turnRate, 1e-3);

  const leadTime = Math.min((flight ?? range / boltSpeed) + swing, MAX_LEAD_TIME);
  const lead = add(target.pos, scale(target.vel, leadTime * tuning.leadAccuracy));
  return model ? add(lead, dodgeCorrection(model, shooter.aimYaw, tuning, config)) : lead;
}

/**
 * Shift the aim towards the way this opponent habitually breaks.
 *
 * DESIGN.md 7.2's "shoot where they dodge to", and the size of it is the whole
 * difficulty. The lead has *already* predicted where a target holding its
 * current velocity will be, so this must only account for the extra deviation
 * from turning, which is `½at²` — a couple of metres over a typical flight,
 * the same order as the hit radius.
 *
 * The first version used `speed x leadTime` instead, which re-applies the lead
 * a second time: at hard difficulty that came out around 17 m against a 1.8 m
 * target and halved the hunter's hit rate. A correction bigger than the thing
 * it is correcting is not a correction.
 */
function dodgeCorrection(
  model: PlayerModel,
  aimYaw: number,
  tuning: AiTuning,
  config: SkyTagConfig,
): Vec3 {
  const lean = model.dodgeLean();
  // Only a habit worth betting a shot on. See DODGE_ACT_THRESHOLD: against an
  // opponent without a real tell the right correction is zero, and applying a
  // small one anyway measures strictly worse than not learning at all.
  if (Math.abs(lean) < DODGE_ACT_THRESHOLD) return { x: 0, y: 0, z: 0 };

  // Scaled by how far a weave displaces a craft at all, which is the only
  // honest bound on how far a habit can put them from the lead. `½at²` was
  // tried and is wrong by an order of magnitude: it assumes full lateral
  // thrust held for the whole flight, where a jink oscillates, and at a 1.5 s
  // lead it produced 16 m corrections that cost hard CPUs ten points of
  // accuracy.
  const offset = lean * config.ai.jinkAmplitude * tuning.leadAccuracy;
  const right = rightVector(aimYaw);
  return { x: right.x * offset, y: 0, z: right.z * offset };
}

/**
 * Where to shoot, given what the AI believes it is looking at.
 *
 * A proper interception solve needs the target's real velocity, which the AI
 * only has for a craft it is genuinely tracking. While it is chasing a decoy,
 * or working from memory, it shoots at the remembered point instead — which is
 * exactly the mistake the decoy is for.
 */
export function shotTarget(ctx: BrainContext): Vec3 | null {
  if (ctx.enemy && ctx.perception.visible && !ctx.perception.fooled) {
    return aimPoint(ctx.self, ctx.enemy, ctx.tuning, ctx.config, ctx.opponent);
  }
  return ctx.estimate;
}

/**
 * A nearby point with no line of sight to `threat`.
 *
 * When nothing sampled is genuinely hidden — normal up in the open sky — it
 * falls back to the densest cover it found, so the runner at least heads
 * towards the city rather than staying in the open, where being slower than
 * the hunter is fatal.
 */
export interface CoverChoice {
  pos: Vec3;
  /**
   * True when the point genuinely breaks line of sight. False means it is only
   * the cluttered direction to run in, which matters because a spot that was
   * never hidden must not be abandoned the instant it is noticed to be exposed.
   */
  hidden: boolean;
}

export function findCover(
  ctx: BrainContext,
  threat: Vec3,
  radius: number,
  samples = 20,
): CoverChoice | null {
  const { self, grid, physics, rng } = ctx;
  const fits = fitRadius(ctx);
  let hidden: Vec3 | null = null;
  let hiddenScore = -Infinity;
  let densest: Vec3 | null = null;
  let densestScore = -Infinity;

  for (let i = 0; i < samples; i++) {
    const candidate = sampleAround(ctx, self.pos, radius);
    // Tested against real geometry, not the navigation voxels: the voxels are
    // inflated for safe routing, and their padding excludes exactly the
    // wall-hugging positions that actually break line of sight.
    if (!physics.isClear(candidate, fits)) continue;

    if (physics.isBlocked(candidate, threat)) {
      // Prefer cover that is close to reach but far from the threat.
      const score = distance(candidate, threat) * 0.5 - distance(candidate, self.pos) + rng.range(0, 8);
      if (score > hiddenScore) {
        hiddenScore = score;
        hidden = candidate;
      }
    } else {
        const score = grid.coverDensity(candidate) * 200 - distance(candidate, self.pos) * 0.4;
      if (score > densestScore) {
        densestScore = score;
        densest = candidate;
      }
    }
  }
  if (hidden) return { pos: hidden, hidden: true };
  // Nothing nearby works. Out over the open edge of the map that is the normal
  // answer, and the fix is to commit to the trip into the city rather than
  // shuffling between equally exposed points.
  const regional = findRegionalCover(ctx, threat);
  if (regional) return regional;
  return densest ? { pos: densest, hidden: false } : null;
}

/**
 * The best precomputed cover hotspot on the map, judged from here.
 *
 * Prefers somewhere genuinely out of sight, then somewhere far from the threat,
 * and penalises the flight time to get there.
 */
export function findRegionalCover(ctx: BrainContext, threat: Vec3): CoverChoice | null {
  const { self, grid, physics } = ctx;
  let best: CoverChoice | null = null;
  let bestScore = -Infinity;

  for (const spot of grid.coverHotspots()) {
    const hidden = physics.isBlocked(spot, threat);
    const score =
      (hidden ? 260 : 0) +
      distance(spot, threat) * 0.6 -
      distance(spot, self.pos);
    if (score > bestScore) {
      bestScore = score;
      best = { pos: spot, hidden };
    }
  }
  return best;
}

/**
 * Somewhere to run to, away from `threat` and in free space.
 * Biased along the escape direction but sampled widely, so the runner does not
 * simply reverse into a wall.
 */
export function findEscape(ctx: BrainContext, threat: Vec3, radius: number, samples = 18): Vec3 {
  const { self, grid, rng } = ctx;
  const away = normalize(sub(self.pos, threat));
  const preferred = add(self.pos, scale(away, radius));

  let best = preferred;
  let bestScore = -Infinity;

  for (let i = 0; i < samples; i++) {
    const candidate = i === 0 ? preferred : sampleAround(ctx, self.pos, radius);
    if (!grid.isFreeAt(candidate)) continue;
    if (!grid.lineIsFree(self.pos, candidate)) continue;

    const escapeDir = normalize(sub(candidate, self.pos));
    const score =
      distance(candidate, threat) +
      dot(escapeDir, away) * 25 +
      // Running into clutter is worth as much as running 40 m further: the
      // hunter is faster, so distance alone never shakes it.
      grid.coverDensity(candidate) * 120 +
      rng.range(0, 10);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * A point to go and look at when the enemy has been lost: near the last known
 * position, offset along where they were heading.
 */
export function searchPoint(ctx: BrainContext, radius: number): Vec3 {
  const { perception, rng, grid } = ctx;
  const anchor = perception.lastSeen?.pos;

  if (!anchor) return sampleArena(ctx);

  // Note for anyone tempted to steer this with the player model: it was tried,
  // twice, and both times measured *worse* than not learning at all (search
  // 3.93s -> 6.07s). The reason is structural rather than a tuning problem.
  // Every positional statistic the AI can gather is a record of sightings, and
  // a sighting is by definition a moment the runner was not hidden — measured,
  // the hunter sees the runner 28% of a round, and the areas it sees them in
  // disagree with where they actually spend their time. Worse, "where they
  // turn up again" is partly a record of where the hunter chose to look, so
  // acting on it makes the CPU search where it already searches. The
  // behavioural statistics (dodge, range, accuracy) carry no such bias, and
  // those are the ones wired into play.
  const heading = perception.lastHeading();
  const lead = heading ? scale(heading, rng.range(10, radius)) : { x: 0, y: 0, z: 0 };
  const guess = add(add(anchor, lead), {
    x: rng.range(-radius, radius) * 0.5,
    y: rng.range(-radius, radius) * 0.3,
    z: rng.range(-radius, radius) * 0.5,
  });

  return grid.isFreeAt(guess) ? guess : (nearestFreePoint(ctx, guess) ?? sampleArena(ctx));
}

/**
 * The most cluttered free point nearby.
 *
 * Used when the runner has no idea where the hunter is: standing in open sky is
 * the worst place to be found, so it goes to ground regardless.
 */
export function findClutter(ctx: BrainContext, radius: number, samples = 16): Vec3 {
  const { self, grid } = ctx;
  let best = self.pos;
  let bestScore = -Infinity;

  for (let i = 0; i < samples; i++) {
    const candidate = sampleAround(ctx, self.pos, radius);
    if (!grid.isFreeAt(candidate)) continue;
    if (!grid.lineIsFree(self.pos, candidate)) continue;

    const score = grid.coverDensity(candidate) * 200 - distance(candidate, self.pos) * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Out in the open nothing nearby is any better than here, so head for the
  // nearest of the map's genuinely cluttered places instead of loitering.
  if (grid.coverDensity(best) < 0.05) {
    let nearest: Vec3 | null = null;
    let nearestDistance = Infinity;
    for (const spot of grid.coverHotspots()) {
      const d = distance(spot, self.pos);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = spot;
      }
    }
    if (nearest) return nearest;
  }
  return best;
}

/** A random free point anywhere in the arena, for when the AI is truly lost. */
export function sampleArena(ctx: BrainContext): Vec3 {
  const { grid, rng } = ctx;
  for (let i = 0; i < 24; i++) {
    const candidate: Vec3 = {
      x: grid.origin.x + rng.next() * grid.dimX * grid.cellSize,
      y: grid.origin.y + rng.range(0.15, 0.8) * grid.dimY * grid.cellSize,
      z: grid.origin.z + rng.next() * grid.dimZ * grid.cellSize,
    };
    if (grid.isFreeAt(candidate)) return candidate;
  }
  // Dead centre of the arena, high up, is free on any sane map.
  return { x: 0, y: grid.origin.y + grid.dimY * grid.cellSize * 0.7, z: 0 };
}

/** Space a craft needs to sit somewhere, as opposed to route through it. */
function fitRadius(ctx: BrainContext): number {
  return ctx.config.flight.bodyRadius * 1.6;
}

/** Offset a point to the nearest free voxel centre, or null if there is none. */
export function nearestFreePoint(ctx: BrainContext, near: Vec3): Vec3 | null {
  const cell = ctx.grid.nearestFree(near);
  return cell ? ctx.grid.toWorld(cell.ix, cell.iy, cell.iz) : null;
}

/** A random point on a sphere around `centre`, biased to stay inside the arena. */
function sampleAround(ctx: BrainContext, centre: Vec3, radius: number): Vec3 {
  const { rng, grid } = ctx;
  const theta = rng.range(0, Math.PI * 2);
  // Flattened vertically: the arena is far wider than it is tall.
  const pitch = rng.range(-0.5, 0.5);
  const horizontal = Math.cos(pitch) * radius * rng.range(0.4, 1);

  const candidate = {
    x: centre.x + Math.cos(theta) * horizontal,
    y: centre.y + Math.sin(pitch) * radius * 0.6,
    z: centre.z + Math.sin(theta) * horizontal,
  };

  // Keep the sample inside the grid, otherwise it is blocked by definition.
  const margin = grid.cellSize * 2;
  const maxX = grid.origin.x + grid.dimX * grid.cellSize - margin;
  const maxY = grid.origin.y + grid.dimY * grid.cellSize - margin;
  const maxZ = grid.origin.z + grid.dimZ * grid.cellSize - margin;
  return {
    x: clamp(candidate.x, grid.origin.x + margin, maxX),
    y: clamp(candidate.y, grid.origin.y + margin, maxY),
    z: clamp(candidate.z, grid.origin.z + margin, maxZ),
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Weave the destination from side to side across the line to a threat.
 *
 * Only worth anything against travelling bolts: a shot is aimed where the
 * target is predicted to be when it arrives, so changing course during the
 * flight is what makes it miss. Against hit-scan this would have done nothing.
 *
 * The weave is perpendicular to the threat and roughly level, so it spoils the
 * lead without steering the runner into the ground or off its escape route.
 */
export function jink(ctx: BrainContext, destination: Vec3, threat: Vec3): Vec3 {
  const { self, config, grid } = ctx;
  const range = distance(self.pos, threat);
  // Outside the hunter's reach there is nothing to dodge, and weaving would
  // only cost distance.
  const reach = config.loadout.hunter.range;
  if (range > reach) return destination;

  const toThreat = normalize(sub(threat, self.pos));
  // Perpendicular, level with the horizon.
  const side = normalize({ x: -toThreat.z, y: 0, z: toThreat.x });
  if (Math.hypot(side.x, side.y, side.z) < 1e-6) return destination;

  // Hardest dodging up close, where the bolt arrives soonest and the hunter is
  // most dangerous; tapering off as the threat recedes.
  const urgency = 1 - Math.min(1, range / reach);
  // The bias shifts the whole weave to one side rather than changing its
  // shape, so a biased runner still dodges — it just spends more of the time
  // on its favoured side, which is what a habit looks like.
  const wave = Math.sin(ctx.memory.jinkPhase * Math.PI * 2 * config.ai.jinkRate);
  const offset =
    (wave * (1 - Math.abs(config.ai.jinkBias)) + config.ai.jinkBias) *
    config.ai.jinkAmplitude *
    urgency;

  const weaved = add(destination, scale(side, offset));
  // Never weave into something solid; the straight line is better than a wall.
  return grid.isFreeAt(weaved) && grid.lineIsFree(self.pos, weaved) ? weaved : destination;
}

/** True when this craft can legitimately take the shot right now. */
export function canShoot(ctx: BrainContext, at: Vec3): boolean {
  const { self, config, physics } = ctx;
  if (self.ammo <= 0 && self.overchargeTimer <= 0) return false;
  if (self.overheated || !self.alive || self.stunTimer > 0) return false;
  if (distance(self.pos, at) > config.loadout[self.team].range) return false;
  return !physics.isBlocked(self.pos, at);
}
