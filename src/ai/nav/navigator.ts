/**
 * Path following: turns "go roughly there" into "fly at this point".
 *
 * Pathfinding is the expensive part of the AI, so the common case never touches
 * it: when the straight line to the goal is clear voxels, the navigator just
 * returns the goal. A* only runs when something is genuinely in the way, and
 * then only on the interval from config (DESIGN.md 7.1).
 */

import type { SkyTagConfig } from '../../sim/config.ts';
import { distance } from '../../sim/math.ts';
import type { Vec3 } from '../../sim/types.ts';
import { PathFinder } from './pathfind.ts';
import type { VoxelGrid } from './voxelGrid.ts';

/** A waypoint counts as reached inside this many cell widths. */
const ARRIVAL_CELLS = 1.1;
/** Repath early if the goal has moved further than this since the last search. */
const GOAL_DRIFT = 18;

export class Navigator {
  private readonly finder: PathFinder;
  private waypoints: Vec3[] = [];
  private pathGoal: Vec3 | null = null;
  private sinceRepath = Number.POSITIVE_INFINITY;
  /** Exposed for the batch tool and tests. */
  lastPathComplete = true;
  searches = 0;

  constructor(
    private readonly grid: VoxelGrid,
    private readonly config: SkyTagConfig,
  ) {
    this.finder = new PathFinder(grid);
  }

  /** Remaining waypoints, for debugging and tests. */
  get path(): readonly Vec3[] {
    return this.waypoints;
  }

  /**
   * The point to fly at this tick in order to reach `goal`.
   * Falls back to the goal itself when no route exists, so the craft always has
   * somewhere to go rather than stalling.
   */
  steer(from: Vec3, goal: Vec3, dt: number): Vec3 {
    this.sinceRepath += dt;

    // Straight shot: no path needed, and this is most ticks in open air.
    if (this.grid.lineIsFree(from, goal)) {
      this.clear();
      return goal;
    }

    const goalMoved = this.pathGoal === null || distance(this.pathGoal, goal) > GOAL_DRIFT;
    const stale = this.sinceRepath >= this.config.ai.repathInterval;
    if (this.waypoints.length === 0 || goalMoved || stale) {
      this.recompute(from, goal);
    }

    // Retire waypoints already reached, and any we can now see past.
    const arrival = this.grid.cellSize * ARRIVAL_CELLS;
    while (this.waypoints.length > 1 && distance(from, this.waypoints[0]!) < arrival) {
      this.waypoints.shift();
    }
    while (this.waypoints.length > 1 && this.grid.lineIsFree(from, this.waypoints[1]!)) {
      this.waypoints.shift();
    }

    return this.waypoints[0] ?? goal;
  }

  private recompute(from: Vec3, goal: Vec3): void {
    this.sinceRepath = 0;
    this.pathGoal = { ...goal };
    this.searches++;

    const result = this.finder.find(from, goal, { maxNodes: this.config.ai.maxPathNodes });
    this.waypoints = result ? [...result.waypoints] : [];
    this.lastPathComplete = result?.complete ?? false;
  }

  clear(): void {
    this.waypoints = [];
    this.pathGoal = null;
  }

  reset(): void {
    this.clear();
    this.sinceRepath = Number.POSITIVE_INFINITY;
    this.lastPathComplete = true;
  }
}
