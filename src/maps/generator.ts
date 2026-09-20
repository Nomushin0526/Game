/**
 * Procedural city generation.
 *
 * Deterministic: the same seed always yields the same map, which is what the
 * AI generalisation tests in `tools/` rely on. Phase 3 extends this with
 * terrain relief, tunnels and bridges; the layer layout is already in place.
 */

import { Rng } from '../sim/rng.ts';
import type { Vec3 } from '../sim/types.ts';
import type { MapData, Solid } from './types.ts';

export interface GenerateOptions {
  sizeX?: number;
  sizeZ?: number;
  ceiling?: number;
  /** Blocks per axis in the street grid. */
  gridCells?: number;
  /** Chance that a grid cell holds a building. */
  buildingDensity?: number;
  /** Number of high-altitude floating obstacles. */
  floaterCount?: number;
  /** Number of spawn candidates to emit. */
  spawnCount?: number;
}

const DEFAULTS: Required<GenerateOptions> = {
  sizeX: 400,
  sizeZ: 400,
  ceiling: 150,
  gridCells: 8,
  buildingDensity: 0.72,
  floaterCount: 10,
  spawnCount: 12,
};

export function generateCityMap(seed: number, options: GenerateOptions = {}): MapData {
  const opt = { ...DEFAULTS, ...options };
  const rng = new Rng(seed);
  const solids: Solid[] = [];

  const cellX = opt.sizeX / opt.gridCells;
  const cellZ = opt.sizeZ / opt.gridCells;
  // Streets between blocks: buildings never fill a whole cell.
  const streetWidth = Math.min(cellX, cellZ) * 0.35;

  for (let ix = 0; ix < opt.gridCells; ix++) {
    for (let iz = 0; iz < opt.gridCells; iz++) {
      if (!rng.bool(opt.buildingDensity)) continue;

      const cx = -opt.sizeX / 2 + (ix + 0.5) * cellX;
      const cz = -opt.sizeZ / 2 + (iz + 0.5) * cellZ;

      // Height falls off towards the arena edge so the middle is the tall,
      // cover-rich duel zone and the rim stays open for chases.
      const edgeDist = Math.min(
        1,
        Math.hypot(cx / (opt.sizeX / 2), cz / (opt.sizeZ / 2)),
      );
      const heightBias = 1 - 0.55 * edgeDist;
      const height = rng.range(12, 90) * heightBias + 6;

      const width = rng.range(0.45, 1.0) * (cellX - streetWidth);
      const depth = rng.range(0.45, 1.0) * (cellZ - streetWidth);
      const jitterX = rng.range(-1, 1) * (cellX - streetWidth - width) * 0.5;
      const jitterZ = rng.range(-1, 1) * (cellZ - streetWidth - depth) * 0.5;

      solids.push({
        shape: 'box',
        pos: { x: cx + jitterX, y: height / 2, z: cz + jitterZ },
        size: { x: width, y: height, z: depth },
        tag: 'building',
      });

      // Tall towers occasionally get a mast, which makes good low-profile cover.
      if (height > 60 && rng.bool(0.4)) {
        solids.push({
          shape: 'cylinder',
          pos: { x: cx + jitterX, y: height + 8, z: cz + jitterZ },
          radius: 1.2,
          height: 16,
          tag: 'prop',
        });
      }
    }
  }

  // Upper layer: sparse floating cover so the open sky is not a pure shooting
  // gallery (DESIGN.md 4.1, 90-150 m band).
  for (let i = 0; i < opt.floaterCount; i++) {
    const radius = rng.range(5, 12);
    solids.push({
      shape: 'cylinder',
      pos: {
        x: rng.range(-opt.sizeX / 2 + radius, opt.sizeX / 2 - radius),
        y: rng.range(95, opt.ceiling - 15),
        z: rng.range(-opt.sizeZ / 2 + radius, opt.sizeZ / 2 - radius),
      },
      radius,
      height: rng.range(4, 9),
      tag: 'floater',
    });
  }

  const spawns = generateSpawns(rng, opt, solids);

  return {
    id: `generated-${seed}`,
    name: `Generated City (seed ${seed})`,
    size: { x: opt.sizeX, z: opt.sizeZ },
    ceiling: opt.ceiling,
    floor: 0,
    spawns,
    solids,
  };
}

/** Rejection-sample points that sit in open air, spread around the arena. */
function generateSpawns(
  rng: Rng,
  opt: Required<GenerateOptions>,
  solids: Solid[],
): Vec3[] {
  const spawns: Vec3[] = [];
  const clearance = 6;
  let attempts = 0;

  while (spawns.length < opt.spawnCount && attempts < opt.spawnCount * 200) {
    attempts++;
    const p: Vec3 = {
      x: rng.range(-opt.sizeX / 2 + 20, opt.sizeX / 2 - 20),
      y: rng.range(25, Math.min(110, opt.ceiling - 20)),
      z: rng.range(-opt.sizeZ / 2 + 20, opt.sizeZ / 2 - 20),
    };
    if (solids.some((s) => intersectsSphere(s, p, clearance))) continue;
    if (spawns.some((q) => dist(p, q) < 60)) continue;
    spawns.push(p);
  }

  // A map with fewer than two spawns is unusable; fall back to opposite corners
  // high above the skyline, which is always clear air.
  if (spawns.length < 2) {
    const y = opt.ceiling - 20;
    spawns.push({ x: -opt.sizeX / 2 + 30, y, z: -opt.sizeZ / 2 + 30 });
    spawns.push({ x: opt.sizeX / 2 - 30, y, z: opt.sizeZ / 2 - 30 });
  }
  return spawns;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Conservative AABB test; exact enough for spawn clearance. */
function intersectsSphere(s: Solid, p: Vec3, radius: number): boolean {
  const half =
    s.shape === 'box'
      ? { x: s.size.x / 2, y: s.size.y / 2, z: s.size.z / 2 }
      : { x: s.radius, y: s.height / 2, z: s.radius };
  return (
    Math.abs(p.x - s.pos.x) < half.x + radius &&
    Math.abs(p.y - s.pos.y) < half.y + radius &&
    Math.abs(p.z - s.pos.z) < half.z + radius
  );
}
