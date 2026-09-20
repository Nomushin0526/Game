/**
 * 3D A* over the navigation voxels, with string-pulled smoothing.
 *
 * Scratch buffers are allocated once per grid and reset with a generation
 * stamp, because clearing 380,000 entries on every search would cost more than
 * the search itself. Searches are weighted and node-capped: a slightly
 * suboptimal path found now beats an optimal one found three ticks late.
 */

import type { Vec3 } from '../../sim/types.ts';
import type { VoxelGrid } from './voxelGrid.ts';

export interface PathOptions {
  /** Give up after this many node expansions. */
  maxNodes?: number;
  /**
   * Heuristic weight. Above 1 trades optimality for speed; at these scales the
   * difference in route quality is invisible and the speed-up is large.
   */
  weight?: number;
}

export interface PathResult {
  /** World-space waypoints, excluding the start. Empty when already there. */
  waypoints: Vec3[];
  /** True when the search reached the goal rather than its node cap. */
  complete: boolean;
  /** Node expansions used, for profiling. */
  expanded: number;
}

/** The 26 neighbours of a cell, with their step costs. */
const NEIGHBOURS: Array<{ dx: number; dy: number; dz: number; cost: number }> = [];
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      NEIGHBOURS.push({ dx, dy, dz, cost: Math.sqrt(dx * dx + dy * dy + dz * dz) });
    }
  }
}

export class PathFinder {
  private readonly gScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly stamp: Int32Array;
  /**
   * Generation a cell was closed in, not a boolean. A boolean would have to be
   * cleared between searches, and anything left set would silently make that
   * cell permanently unreachable.
   */
  private readonly closedGen: Int32Array;
  private generation = 0;
  private readonly open: MinHeap;

  constructor(private readonly grid: VoxelGrid) {
    const cells = grid.cellCount;
    this.gScore = new Float32Array(cells);
    this.cameFrom = new Int32Array(cells);
    this.stamp = new Int32Array(cells);
    this.closedGen = new Int32Array(cells);
    this.open = new MinHeap();
  }

  /**
   * Route from `startPos` to `goalPos`.
   *
   * Both ends are nudged to the nearest free cell first, since a craft pressed
   * against a wall is routinely inside the inflated obstacle. Returns null when
   * either end has no reachable free cell at all.
   */
  find(startPos: Vec3, goalPos: Vec3, options: PathOptions = {}): PathResult | null {
    const grid = this.grid;
    const maxNodes = options.maxNodes ?? 8000;
    const weight = options.weight ?? 1.25;

    const startCell = grid.nearestFree(startPos);
    const goalCell = grid.nearestFree(goalPos);
    if (!startCell || !goalCell) return null;

    const start = grid.index(startCell.ix, startCell.iy, startCell.iz);
    const goal = grid.index(goalCell.ix, goalCell.iy, goalCell.iz);
    if (start === goal) return { waypoints: [], complete: true, expanded: 0 };

    this.generation++;
    this.open.clear();
    this.setG(start, 0);
    this.cameFrom[start] = -1;
    this.open.push(start, this.heuristic(start, goalCell) * weight);

    let expanded = 0;
    /** Best node seen so far, so a capped search still returns useful progress. */
    let bestNode = start;
    let bestHeuristic = this.heuristic(start, goalCell);

    while (this.open.size > 0 && expanded < maxNodes) {
      const current = this.open.pop();
      if (this.closedGen[current] === this.generation) continue;
      this.closedGen[current] = this.generation;
      expanded++;

      if (current === goal) {
        return { waypoints: this.reconstruct(current, startPos), complete: true, expanded };
      }

      const cell = grid.cellOfIndex(current);
      const g = this.getG(current);

      for (const step of NEIGHBOURS) {
        const ix = cell.ix + step.dx;
        const iy = cell.iy + step.dy;
        const iz = cell.iz + step.dz;
        if (!grid.isFree(ix, iy, iz)) continue;

        const neighbour = grid.index(ix, iy, iz);
        if (this.closedGen[neighbour] === this.generation) continue;

        const tentative = g + step.cost;
        if (tentative >= this.getG(neighbour)) continue;

        this.setG(neighbour, tentative);
        this.cameFrom[neighbour] = current;

        const h = this.heuristic(neighbour, goalCell);
        if (h < bestHeuristic) {
          bestHeuristic = h;
          bestNode = neighbour;
        }
        this.open.push(neighbour, tentative + h * weight);
      }
    }

    // Out of budget or out of reachable space: head for the closest point we
    // did find. Standing still because the goal is unreachable is worse.
    if (bestNode === start) return null;
    return { waypoints: this.reconstruct(bestNode, startPos), complete: false, expanded };
  }

  private heuristic(index: number, goal: { ix: number; iy: number; iz: number }): number {
    const cell = this.grid.cellOfIndex(index);
    return Math.hypot(cell.ix - goal.ix, cell.iy - goal.iy, cell.iz - goal.iz);
  }

  /** Generation-stamped read: anything not written this search is "infinity". */
  private getG(index: number): number {
    return this.stamp[index] === this.generation ? this.gScore[index]! : Infinity;
  }

  private setG(index: number, value: number): void {
    this.stamp[index] = this.generation;
    this.gScore[index] = value;
  }

  private reconstruct(goal: number, startPos: Vec3): Vec3[] {
    const cells: number[] = [];
    // Only follow links written during this search; older ones are garbage.
    for (let node = goal; node !== -1 && this.stamp[node] === this.generation; node = this.cameFrom[node]!) {
      cells.push(node);
    }
    cells.reverse();
    // Drop the start cell: the craft is already there.
    const points = cells.slice(1).map((index) => this.grid.worldOfIndex(index));
    return smoothPath(this.grid, startPos, points);
  }
}

/**
 * String pulling: drop any waypoint the craft can see past.
 *
 * Raw A* output is a staircase of cell centres. Flying it verbatim looks
 * robotic and wastes distance; this collapses it to the corners that matter.
 */
export function smoothPath(grid: VoxelGrid, start: Vec3, points: readonly Vec3[]): Vec3[] {
  if (points.length <= 1) return [...points];

  const smoothed: Vec3[] = [];
  let anchor = start;
  let index = 0;

  while (index < points.length) {
    // Furthest point still reachable in a straight line from the anchor.
    let furthest = index;
    for (let candidate = points.length - 1; candidate > index; candidate--) {
      if (grid.lineIsFree(anchor, points[candidate]!)) {
        furthest = candidate;
        break;
      }
    }
    smoothed.push(points[furthest]!);
    anchor = points[furthest]!;
    index = furthest + 1;
  }
  return smoothed;
}

/** Binary heap keyed on f-score. Parallel arrays to keep it allocation-free. */
class MinHeap {
  private items = new Int32Array(1024);
  private priorities = new Float32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(item: number, priority: number): void {
    if (this.size === this.items.length) this.grow();
    let i = this.size++;
    this.items[i] = item;
    this.priorities[i] = priority;

    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent]! <= this.priorities[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size]!;
      this.priorities[0] = this.priorities[this.size]!;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(start: number): void {
    let i = start;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.size && this.priorities[left]! < this.priorities[smallest]!) smallest = left;
      if (right < this.size && this.priorities[right]! < this.priorities[smallest]!) smallest = right;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const item = this.items[a]!;
    const priority = this.priorities[a]!;
    this.items[a] = this.items[b]!;
    this.priorities[a] = this.priorities[b]!;
    this.items[b] = item;
    this.priorities[b] = priority;
  }

  private grow(): void {
    const items = new Int32Array(this.items.length * 2);
    const priorities = new Float32Array(this.priorities.length * 2);
    items.set(this.items);
    priorities.set(this.priorities);
    this.items = items;
    this.priorities = priorities;
  }
}
