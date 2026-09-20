import { beforeAll, describe, expect, it } from 'vitest';
import { PathFinder, smoothPath } from '../src/ai/nav/pathfind.ts';
import { VoxelGrid } from '../src/ai/nav/voxelGrid.ts';
import { Navigator } from '../src/ai/nav/navigator.ts';
import { loadMap } from '../src/maps/loader.ts';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { initPhysics } from '../src/sim/physics.ts';
import type { MapData } from '../src/maps/types.ts';

/** A 200 m cube of air with one wall across the middle, and a doorway in it. */
const WALL_MAP: MapData = {
  id: 'wall',
  name: 'Wall',
  size: { x: 200, z: 200 },
  ceiling: 100,
  floor: 0,
  spawns: [{ x: -80, y: 50, z: 0 }, { x: 80, y: 50, z: 0 }],
  solids: [
    // Two panels leaving a gap around z = 0.
    { shape: 'box', pos: { x: 0, y: 50, z: -60 }, size: { x: 4, y: 100, z: 80 }, tag: 'building' },
    { shape: 'box', pos: { x: 0, y: 50, z: 60 }, size: { x: 4, y: 100, z: 80 }, tag: 'building' },
  ],
};

const OPTIONS = { cellSize: 4, clearance: 2.5 };

beforeAll(async () => {
  await initPhysics();
});

describe('VoxelGrid', () => {
  const grid = new VoxelGrid(WALL_MAP, OPTIONS);

  it('covers the arena at the configured cell size', () => {
    expect(grid.dimX).toBe(50);
    expect(grid.dimZ).toBe(50);
    expect(grid.dimY).toBe(25);
    expect(grid.cellCount).toBe(50 * 25 * 50);
  });

  it('round-trips a position through a cell', () => {
    const cell = grid.toCell({ x: 10, y: 50, z: -30 });
    const centre = grid.toWorld(cell.ix, cell.iy, cell.iz);
    expect(Math.abs(centre.x - 10)).toBeLessThanOrEqual(grid.cellSize / 2);
    expect(Math.abs(centre.y - 50)).toBeLessThanOrEqual(grid.cellSize / 2);
    expect(Math.abs(centre.z + 30)).toBeLessThanOrEqual(grid.cellSize / 2);
  });

  it('round-trips a cell through its flat index', () => {
    for (const cell of [{ ix: 0, iy: 0, iz: 0 }, { ix: 13, iy: 7, iz: 41 }, { ix: 49, iy: 24, iz: 49 }]) {
      expect(grid.cellOfIndex(grid.index(cell.ix, cell.iy, cell.iz))).toEqual(cell);
    }
  });

  it('blocks solids and leaves open air free', () => {
    expect(grid.isFreeAt({ x: 0, y: 50, z: -60 })).toBe(false);
    expect(grid.isFreeAt({ x: 40, y: 50, z: 0 })).toBe(true);
    // The doorway between the two panels.
    expect(grid.isFreeAt({ x: 0, y: 50, z: 0 })).toBe(true);
  });

  it('blocks the arena boundary and the ceiling', () => {
    expect(grid.isFreeAt({ x: -99, y: 50, z: 0 })).toBe(false);
    expect(grid.isFreeAt({ x: 0, y: 99, z: 0 })).toBe(false);
    expect(grid.isFreeAt({ x: 0, y: 1, z: 0 })).toBe(false);
  });

  it('does not count the invisible walls as cover', () => {
    // A corner is enclosed by boundary on two sides and the ground below, but
    // there is nothing there to hide behind. Counting boundary as cover made
    // the map's corners score as its most sheltered spots.
    const corner = { x: -92, y: 50, z: -92 };
    const middle = { x: 0, y: 50, z: -50 };
    expect(grid.coverDensity(corner)).toBe(0);
    expect(grid.coverDensity(middle)).toBeGreaterThan(0);
  });

  it('tells geometry apart from the boundary', () => {
    const wall = grid.toCell({ x: 0, y: 50, z: -60 });
    const edge = grid.toCell({ x: -99, y: 50, z: 0 });
    expect(grid.isGeometry(wall.ix, wall.iy, wall.iz)).toBe(true);
    expect(grid.isGeometry(edge.ix, edge.iy, edge.iz)).toBe(false);
    expect(grid.isFree(edge.ix, edge.iy, edge.iz)).toBe(false);
  });

  it('answers straight-line freedom', () => {
    expect(grid.lineIsFree({ x: -60, y: 50, z: -60 }, { x: 60, y: 50, z: -60 })).toBe(false);
    expect(grid.lineIsFree({ x: -60, y: 50, z: 0 }, { x: 60, y: 50, z: 0 })).toBe(true);
  });

  it('finds the nearest free cell to a blocked position', () => {
    const cell = grid.nearestFree({ x: 0, y: 50, z: -60 });
    expect(cell).not.toBeNull();
    expect(grid.isFree(cell!.ix, cell!.iy, cell!.iz)).toBe(true);
  });

  it('keeps a majority of the arena flyable', () => {
    expect(grid.freeFraction()).toBeGreaterThan(0.5);
  });

  it('returns cover hotspots that really are cluttered', () => {
    const city = new VoxelGrid(loadMap('city01'), OPTIONS);
    const spots = city.coverHotspots(20);
    expect(spots.length).toBeGreaterThan(5);
    for (const spot of spots) {
      expect(city.isFreeAt(spot)).toBe(true);
      expect(city.coverDensity(spot, city.cellSize * 5)).toBeGreaterThan(0.05);
    }
  });
});

describe('PathFinder', () => {
  const grid = new VoxelGrid(WALL_MAP, OPTIONS);

  it('routes around a wall through the gap', () => {
    const finder = new PathFinder(grid);
    const path = finder.find({ x: -80, y: 50, z: -60 }, { x: 80, y: 50, z: -60 });
    expect(path).not.toBeNull();
    expect(path!.complete).toBe(true);
    expect(path!.waypoints.length).toBeGreaterThan(0);

    // Every leg of the route has to be flyable.
    let previous = { x: -80, y: 50, z: -60 };
    for (const waypoint of path!.waypoints) {
      expect(grid.lineIsFree(previous, waypoint)).toBe(true);
      previous = waypoint;
    }
    const last = path!.waypoints.at(-1)!;
    expect(Math.hypot(last.x - 80, last.y - 50, last.z + 60)).toBeLessThan(3 * grid.cellSize);
  });

  it('stays correct across repeated searches', () => {
    // Regression: the closed set used to be a plain boolean array that was
    // never cleared, so every cell closed by one search became permanently
    // unreachable for the next one.
    const finder = new PathFinder(grid);
    const from = { x: -80, y: 50, z: -60 };
    const to = { x: 80, y: 50, z: -60 };
    const first = finder.find(from, to);

    for (let i = 0; i < 25; i++) {
      finder.find({ x: -80, y: 20 + i, z: 40 }, { x: 80, y: 60, z: -40 });
    }

    const again = finder.find(from, to);
    expect(again).not.toBeNull();
    expect(again!.complete).toBe(true);
    expect(again!.waypoints.length).toBe(first!.waypoints.length);
  });

  it('returns nothing between two points with no free cell anywhere near', () => {
    const sealed: MapData = {
      ...WALL_MAP,
      solids: [{ shape: 'box', pos: { x: 0, y: 50, z: 0 }, size: { x: 120, y: 90, z: 120 }, tag: 'building' }],
    };
    const finder = new PathFinder(new VoxelGrid(sealed, OPTIONS));
    expect(finder.find({ x: 0, y: 50, z: 0 }, { x: 10, y: 50, z: 10 })).toBeNull();
  });

  it('reports an empty path when start and goal share a cell', () => {
    const finder = new PathFinder(grid);
    const path = finder.find({ x: 40, y: 50, z: 0 }, { x: 41, y: 50, z: 0 });
    expect(path!.waypoints).toEqual([]);
    expect(path!.complete).toBe(true);
  });

  it('smooths a staircase down to its corners', () => {
    const staircase = Array.from({ length: 10 }, (_, i) => ({ x: 40 + i * 4, y: 50, z: 0 }));
    const smoothed = smoothPath(grid, { x: 40, y: 50, z: 0 }, staircase);
    // All in open air and in a straight line, so only the far end survives.
    expect(smoothed).toHaveLength(1);
    expect(smoothed[0]).toEqual(staircase.at(-1));
  });
});

describe('Navigator', () => {
  const grid = new VoxelGrid(WALL_MAP, OPTIONS);

  it('flies straight at the goal when nothing is in the way', () => {
    const nav = new Navigator(grid, CONFIG);
    const goal = { x: 60, y: 50, z: 0 };
    expect(nav.steer({ x: -60, y: 50, z: 0 }, goal, 1 / 60)).toEqual(goal);
    // No search was needed at all, which is the point of the fast path.
    expect(nav.searches).toBe(0);
  });

  it('paths around an obstacle and hands back a reachable waypoint', () => {
    const nav = new Navigator(grid, CONFIG);
    const from = { x: -80, y: 50, z: -60 };
    const goal = { x: 80, y: 50, z: -60 };

    const waypoint = nav.steer(from, goal, 1 / 60);
    expect(nav.searches).toBe(1);
    expect(waypoint).not.toEqual(goal);
    expect(grid.lineIsFree(from, waypoint)).toBe(true);
  });

  it('does not repath on every tick', () => {
    const config = cloneConfig();
    const nav = new Navigator(grid, config);
    const from = { x: -80, y: 50, z: -60 };
    const goal = { x: 80, y: 50, z: -60 };

    for (let i = 0; i < 20; i++) nav.steer(from, goal, config.sim.fixedDt);
    expect(nav.searches).toBe(1);

    // Past the repath interval it refreshes.
    for (let i = 0; i < Math.ceil(config.ai.repathInterval * config.sim.tickRate); i++) {
      nav.steer(from, goal, config.sim.fixedDt);
    }
    expect(nav.searches).toBe(2);
  });

  it('forgets its path once the goal comes into the open', () => {
    const nav = new Navigator(grid, CONFIG);
    nav.steer({ x: -80, y: 50, z: -60 }, { x: 80, y: 50, z: -60 }, 1 / 60);
    expect(nav.path.length).toBeGreaterThan(0);

    nav.steer({ x: -60, y: 50, z: 0 }, { x: 60, y: 50, z: 0 }, 1 / 60);
    expect(nav.path.length).toBe(0);
  });
});
