/** Shared shapes for the utility AI (DESIGN.md 7.1). */

import type { AiTuning, SkyTagConfig } from '../sim/config.ts';
import type { PhysicsWorld } from '../sim/physics.ts';
import { Rng } from '../sim/rng.ts';
import type { EntityState, Vec3 } from '../sim/types.ts';
import type { Navigator } from './nav/navigator.ts';
import type { VoxelGrid } from './nav/voxelGrid.ts';
import type { Perception } from './perception.ts';

/**
 * What a brain wants this tick, in world terms.
 * The controller turns it into a `PlayerInput`, applying aim speed and error.
 */
export interface Intent {
  /** World point to fly towards, or null to coast. */
  moveTo: Vec3 | null;
  /** World point to aim at, or null to look where it is going. */
  lookAt: Vec3 | null;
  fire: boolean;
  boost: boolean;
}

/**
 * Scratch space that survives between ticks.
 *
 * Actions hold onto a chosen destination here rather than re-picking one every
 * tick, which is what stops the AI dithering: without it, `findEscape` would
 * sample a fresh point 60 times a second and the craft would never get anywhere.
 */
export interface BrainMemory {
  searchTarget: Vec3 | null;
  ambushSpot: Vec3 | null;
  escapeTarget: Vec3 | null;
  coverSpot: Vec3 | null;
  /** Whether `coverSpot` actually breaks line of sight, or is merely towards cover. */
  coverIsHidden: boolean;
  /**
   * Seconds left before `coverSpot` may be abandoned for being exposed.
   *
   * Cover 150 m away takes several seconds to reach, and the hunter moves the
   * whole time. Without a commitment window the spot is invalidated on the next
   * decision tick, a different one is chosen, and the runner is pulled back and
   * forth without ever arriving anywhere.
   */
  coverCommit: number;
}

export function createMemory(): BrainMemory {
  return {
    searchTarget: null,
    ambushSpot: null,
    escapeTarget: null,
    coverSpot: null,
    coverIsHidden: false,
    coverCommit: 0,
  };
}

export interface BrainContext {
  self: EntityState;
  enemy: EntityState | undefined;
  perception: Perception;
  nav: Navigator;
  grid: VoxelGrid;
  physics: PhysicsWorld;
  config: SkyTagConfig;
  tuning: AiTuning;
  rng: Rng;
  memory: BrainMemory;
  /**
   * True only on ticks where the utility scores were re-evaluated.
   *
   * Re-picking a destination means sampling and ray casting, which is far too
   * expensive to do 60 times a second — and doing so also makes the AI dither,
   * because each sample lands somewhere slightly different.
   */
  decisionTick: boolean;
  dt: number;
  /** Seconds left in the round; the runner cares a lot about this. */
  timeRemaining: number;
  /** Best guess at the enemy's position, or null when it has no idea. */
  estimate: Vec3 | null;
  /** Straight-line distance to the enemy's estimated position, or Infinity. */
  range: number;
}

/**
 * One scored behaviour. `score` is compared across all of a brain's actions and
 * the highest wins; `act` is only called on the winner.
 *
 * `act` must be total. Actions are chosen on the decision interval but acted on
 * every tick, so whatever `score` relied on can go stale in between — a
 * remembered enemy position expiring mid-chase is the obvious one. An action
 * that assumes its own preconditions still hold will eventually be wrong.
 */
export interface Action {
  readonly name: string;
  score(ctx: BrainContext): number;
  act(ctx: BrainContext): Intent;
}

export interface Brain {
  readonly actions: readonly Action[];
}

export function coast(): Intent {
  return { moveTo: null, lookAt: null, fire: false, boost: false };
}

/**
 * Pick the highest-scoring action, with a bonus for whatever is already
 * running so that two near-tied behaviours do not alternate every tick.
 */
export function chooseAction(
  brain: Brain,
  ctx: BrainContext,
  current: Action | null,
): Action {
  let best = brain.actions[0]!;
  let bestScore = -Infinity;

  for (const action of brain.actions) {
    let score = action.score(ctx);
    if (action === current) score += ctx.config.ai.actionHysteresis;
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

export { Rng };
