/**
 * Shared tactical helpers: picking cover, picking somewhere to run, and working
 * out where to aim at a moving target.
 *
 * Everything here samples candidate points and scores them. Sampling is driven
 * by the AI's seeded RNG, so two runs of the same match play out identically.
 */

import type { AiTuning } from '../sim/config.ts';
import { add, distance, dot, forwardVector, normalize, scale, sub } from '../sim/math.ts';
import type { EntityState, Vec3 } from '../sim/types.ts';
import type { BrainContext } from './types.ts';

/** How far ahead of a target the AI is ever willing to aim, seconds. */
const MAX_LEAD_TIME = 0.6;

/**
 * Where to aim to hit a moving target.
 *
 * The gun is hit-scan, so there is no travel time to lead: what has to be
 * compensated for is the AI's own turn rate. It aims at where the target will
 * be once the swing onto it is finished, scaled by the difficulty's
 * `leadAccuracy` so that weaker CPUs under-lead and miss behind.
 */
export function aimPoint(shooter: EntityState, target: EntityState, tuning: AiTuning): Vec3 {
  const toTarget = sub(target.pos, shooter.pos);
  const range = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
  if (range < 1e-3) return { ...target.pos };

  const forward = forwardVector(shooter.aimYaw, shooter.aimPitch);
  const cosAngle = Math.max(-1, Math.min(1, dot(forward, scale(toTarget, 1 / range))));
  const swing = Math.acos(cosAngle);

  const leadTime = Math.min(swing / Math.max(tuning.turnRate, 1e-3), MAX_LEAD_TIME);
  return add(target.pos, scale(target.vel, leadTime * tuning.leadAccuracy));
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

/** True when this craft can legitimately take the shot right now. */
export function canShoot(ctx: BrainContext, at: Vec3): boolean {
  const { self, config, physics } = ctx;
  if (self.overheated || !self.alive || self.stunTimer > 0) return false;
  if (distance(self.pos, at) > config.loadout[self.team].range) return false;
  return !physics.isBlocked(self.pos, at);
}
