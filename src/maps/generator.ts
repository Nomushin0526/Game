/**
 * Procedural city generation.
 *
 * Deterministic: the same seed always yields the same map, which is what the
 * AI generalisation tests rely on. The output covers all three altitude bands
 * from DESIGN.md 4.1 — relief, low buildings, trees, tunnels and elevated
 * roadways on the ground; towers, walkways and cranes in the middle; balloons
 * and floating islands up top.
 */

import { Rng } from '../sim/rng.ts';
import type { Vec3 } from '../sim/types.ts';
import { Terrain } from './terrain.ts';
import { tunnelSolids, type CloudVolume, type MapData, type Solid, type TunnelDef } from './types.ts';

export interface GenerateOptions {
  sizeX?: number;
  sizeZ?: number;
  ceiling?: number;
  /** Clusters of sight-blocking cloud placed in the upper air. */
  cloudBanks?: number;
  /** Blocks per axis in the street grid. */
  gridCells?: number;
  /** Chance that a grid cell holds a building. */
  buildingDensity?: number;
  /** Peak ground relief in metres. 0 disables terrain entirely. */
  terrainHeight?: number;
  /** Height-field grid resolution. */
  terrainResolution?: number;
  treeCount?: number;
  tunnelCount?: number;
  /** Elevated roadways crossing the map at low altitude. */
  viaductCount?: number;
  /** Chance a tall tower carries a construction crane. */
  craneChance?: number;
  /** Number of high-altitude floating obstacles. */
  floaterCount?: number;
  /** Number of spawn candidates to emit. */
  spawnCount?: number;
}

const DEFAULTS: Required<GenerateOptions> = {
  sizeX: 400,
  sizeZ: 400,
  ceiling: 150,
  cloudBanks: 7,
  gridCells: 8,
  buildingDensity: 0.7,
  terrainHeight: 22,
  terrainResolution: 32,
  treeCount: 70,
  tunnelCount: 3,
  viaductCount: 2,
  craneChance: 0.35,
  floaterCount: 12,
  spawnCount: 14,
};

/** Altitude band boundaries from DESIGN.md 4.1. */
const MID_LAYER_FLOOR = 30;
const UPPER_LAYER_FLOOR = 90;

export function generateCityMap(seed: number, options: GenerateOptions = {}): MapData {
  const opt = { ...DEFAULTS, ...options };
  const rng = new Rng(seed);
  const solids: Solid[] = [];

  const terrain = opt.terrainHeight > 0
    ? Terrain.fromDef(
        {
          resolution: opt.terrainResolution,
          maxHeight: opt.terrainHeight,
          seed: seed ^ 0x5eed,
          featureSize: 9,
          octaves: 4,
        },
        opt.sizeX,
        opt.sizeZ,
      )
    : undefined;
  const ground = (x: number, z: number): number => terrain?.heightAt(x, z) ?? 0;

  const blocks = layOutBlocks(rng, opt, ground, solids);
  addSkyWalkways(rng, blocks, solids);
  addCranes(rng, opt, blocks, solids);
  addViaducts(rng, opt, ground, solids);
  addTunnels(rng, opt, ground, solids);
  addTrees(rng, opt, ground, blocks, solids);
  addFloaters(rng, opt, solids);

  return {
    id: `generated-${seed}`,
    name: `Generated City (seed ${seed})`,
    size: { x: opt.sizeX, z: opt.sizeZ },
    ceiling: opt.ceiling,
    floor: 0,
    terrain,
    spawns: generateSpawns(rng, opt, solids, ground),
    solids,
    clouds: generateClouds(rng, opt),
  };
}

/** One placed building, kept so later passes can connect and decorate them. */
interface Block {
  x: number;
  z: number;
  width: number;
  depth: number;
  /** World height of the roof. */
  top: number;
  /** Grid coordinates, for finding neighbours. */
  ix: number;
  iz: number;
}

/**
 * The street grid. Height falls off towards the arena edge so the middle is the
 * tall, cover-rich duel zone and the rim stays open for chases.
 */
function layOutBlocks(
  rng: Rng,
  opt: Required<GenerateOptions>,
  ground: (x: number, z: number) => number,
  solids: Solid[],
): Block[] {
  const blocks: Block[] = [];
  const cellX = opt.sizeX / opt.gridCells;
  const cellZ = opt.sizeZ / opt.gridCells;
  const streetWidth = Math.min(cellX, cellZ) * 0.35;

  for (let ix = 0; ix < opt.gridCells; ix++) {
    for (let iz = 0; iz < opt.gridCells; iz++) {
      if (!rng.bool(opt.buildingDensity)) continue;

      const cx = -opt.sizeX / 2 + (ix + 0.5) * cellX;
      const cz = -opt.sizeZ / 2 + (iz + 0.5) * cellZ;
      const edgeDist = Math.min(1, Math.hypot(cx / (opt.sizeX / 2), cz / (opt.sizeZ / 2)));
      const heightBias = 1 - 0.55 * edgeDist;
      const height = rng.range(12, 90) * heightBias + 6;

      const width = rng.range(0.45, 1.0) * (cellX - streetWidth);
      const depth = rng.range(0.45, 1.0) * (cellZ - streetWidth);
      const x = cx + rng.range(-1, 1) * (cellX - streetWidth - width) * 0.5;
      const z = cz + rng.range(-1, 1) * (cellZ - streetWidth - depth) * 0.5;

      const base = footprintBase(ground, x, z, width, depth);
      const block = placeOnGround(solids, x, z, width, depth, height, base, 'building');
      blocks.push({ ...block, ix, iz });
    }
  }
  return blocks;
}

/**
 * Sink a box into the ground so it never floats on the downhill side of a
 * slope. Returns the block, whose `top` is the usable roof height.
 */
function placeOnGround(
  solids: Solid[],
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  base: number,
  tag: Solid['tag'],
): Omit<Block, 'ix' | 'iz'> {
  const embed = 3;
  const total = height + embed;
  solids.push({
    shape: 'box',
    pos: { x, y: base - embed + total / 2, z },
    size: { x: width, y: total, z: depth },
    tag,
  });
  return { x, z, width, depth, top: base + height };
}

/** Lowest ground height under a footprint, so nothing is left hanging. */
function footprintBase(
  ground: (x: number, z: number) => number,
  x: number,
  z: number,
  width: number,
  depth: number,
): number {
  let min = Infinity;
  for (const dx of [-0.5, 0, 0.5]) {
    for (const dz of [-0.5, 0, 0.5]) {
      min = Math.min(min, ground(x + dx * width, z + dz * depth));
    }
  }
  return min;
}

/** Walkways between neighbouring towers (DESIGN.md 4.1, mid layer). */
function addSkyWalkways(rng: Rng, blocks: Block[], solids: Solid[]): void {
  const byCell = new Map<string, Block>();
  for (const block of blocks) byCell.set(`${block.ix},${block.iz}`, block);

  for (const block of blocks) {
    if (block.top < MID_LAYER_FLOOR) continue;
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const neighbour = byCell.get(`${block.ix + dx},${block.iz + dz}`);
      if (!neighbour || neighbour.top < MID_LAYER_FLOOR) continue;
      if (!rng.bool(0.45)) continue;

      // Hang the walkway below both roofs so it reads as a connecting bridge.
      const y = Math.min(block.top, neighbour.top) - rng.range(4, 14);
      if (y < MID_LAYER_FLOOR) continue;

      const span = Math.hypot(neighbour.x - block.x, neighbour.z - block.z);
      solids.push({
        shape: 'box',
        pos: { x: (block.x + neighbour.x) / 2, y, z: (block.z + neighbour.z) / 2 },
        size: dx === 1
          ? { x: span, y: 1.6, z: 5 }
          : { x: 5, y: 1.6, z: span },
        tag: 'bridge',
      });
    }
  }
}

/** Construction cranes on the tallest towers: a mast, a jib and a counterweight. */
function addCranes(
  rng: Rng,
  opt: Required<GenerateOptions>,
  blocks: Block[],
  solids: Solid[],
): void {
  for (const block of blocks) {
    if (block.top < 55 || !rng.bool(opt.craneChance)) continue;

    const mastHeight = rng.range(14, 26);
    const jibY = block.top + mastHeight;
    if (jibY > opt.ceiling - 6) continue;

    solids.push({
      shape: 'cylinder',
      pos: { x: block.x, y: block.top + mastHeight / 2, z: block.z },
      radius: 1.3,
      height: mastHeight,
      tag: 'crane',
    });

    const jibLength = rng.range(26, 42);
    const rotY = rng.range(0, Math.PI * 2);
    solids.push({
      shape: 'box',
      // Offset so the long arm reaches out one side and a short tail the other.
      pos: {
        x: block.x + Math.cos(rotY) * jibLength * 0.18,
        y: jibY,
        z: block.z - Math.sin(rotY) * jibLength * 0.18,
      },
      size: { x: jibLength, y: 1.6, z: 2.4 },
      rotY,
      tag: 'crane',
    });
  }
}

/** Elevated roadways: long decks on pillars, crossing the ground layer. */
function addViaducts(
  rng: Rng,
  opt: Required<GenerateOptions>,
  ground: (x: number, z: number) => number,
  solids: Solid[],
): void {
  for (let i = 0; i < opt.viaductCount; i++) {
    const alongX = rng.bool();
    const deckY = rng.range(20, 28);
    const offset = rng.range(-0.35, 0.35) * (alongX ? opt.sizeZ : opt.sizeX);
    const length = (alongX ? opt.sizeX : opt.sizeZ) * 0.85;

    const x = alongX ? 0 : offset;
    const z = alongX ? offset : 0;
    solids.push({
      shape: 'box',
      pos: { x, y: deckY, z },
      size: alongX ? { x: length, y: 2, z: 9 } : { x: 9, y: 2, z: length },
      tag: 'bridge',
    });

    // Pillars down to whatever the ground is doing underneath.
    const pillars = 6;
    for (let p = 0; p < pillars; p++) {
      const t = (p + 0.5) / pillars - 0.5;
      const px = alongX ? t * length : x;
      const pz = alongX ? z : t * length;
      const base = ground(px, pz);
      const height = deckY - 1 - base;
      if (height <= 2) continue;
      solids.push({
        shape: 'cylinder',
        pos: { x: px, y: base + height / 2, z: pz },
        radius: 2,
        height,
        tag: 'bridge',
      });
    }
  }
}

/** Covered passages at ground level: somewhere to break line of sight low down. */
function addTunnels(
  rng: Rng,
  opt: Required<GenerateOptions>,
  ground: (x: number, z: number) => number,
  solids: Solid[],
): void {
  for (let i = 0; i < opt.tunnelCount; i++) {
    const rotY = rng.bool() ? 0 : Math.PI / 2;
    const x = rng.range(-0.35, 0.35) * opt.sizeX;
    const z = rng.range(-0.35, 0.35) * opt.sizeZ;
    const height = rng.range(10, 16);

    const tunnel: TunnelDef = {
      pos: { x, y: ground(x, z) + height / 2 + 1, z },
      length: rng.range(70, 130),
      width: rng.range(14, 22),
      height,
      thickness: 3,
      rotY,
    };
    solids.push(...tunnelSolids(tunnel));
  }
}

/** Tree cover on the open ground between blocks. */
function addTrees(
  rng: Rng,
  opt: Required<GenerateOptions>,
  ground: (x: number, z: number) => number,
  blocks: Block[],
  solids: Solid[],
): void {
  let placed = 0;
  let attempts = 0;
  while (placed < opt.treeCount && attempts < opt.treeCount * 30) {
    attempts++;
    const x = rng.range(-opt.sizeX / 2 + 8, opt.sizeX / 2 - 8);
    const z = rng.range(-opt.sizeZ / 2 + 8, opt.sizeZ / 2 - 8);
    // Streets and parks only: never inside a building footprint.
    if (blocks.some((b) => Math.abs(x - b.x) < b.width / 2 + 4 && Math.abs(z - b.z) < b.depth / 2 + 4)) {
      continue;
    }

    const base = ground(x, z);
    const trunk = rng.range(4, 7);
    const canopy = rng.range(4, 7);
    solids.push(
      { shape: 'cylinder', pos: { x, y: base + trunk / 2, z }, radius: 0.6, height: trunk, tag: 'tree' },
      {
        shape: 'cylinder',
        pos: { x, y: base + trunk + canopy / 2, z },
        radius: rng.range(2.5, 4.5),
        height: canopy,
        tag: 'tree',
      },
    );
    placed++;
  }
}

/** Balloons and floating islands in the open upper band. */
function addFloaters(rng: Rng, opt: Required<GenerateOptions>, solids: Solid[]): void {
  for (let i = 0; i < opt.floaterCount; i++) {
    const radius = rng.range(5, 13);
    solids.push({
      shape: 'cylinder',
      pos: {
        x: rng.range(-opt.sizeX / 2 + radius, opt.sizeX / 2 - radius),
        y: rng.range(UPPER_LAYER_FLOOR + 5, opt.ceiling - 15),
        z: rng.range(-opt.sizeZ / 2 + radius, opt.sizeZ / 2 - radius),
      },
      radius,
      height: rng.range(4, 9),
      tag: 'floater',
    });
  }
}

/**
 * Fill the upper air with cloud.
 *
 * Solids cluster around the rooftops, which left the top half of the arena as
 * open sky where a chase is decided by nothing but speed. Cloud gives that
 * volume something to hide in without making altitude lethal.
 *
 * Banks are placed in overlapping clusters rather than one at a time: a single
 * sphere is a ball you fly around, while a clump of them is weather you go
 * into and lose someone in.
 */
function generateClouds(rng: Rng, opt: Required<GenerateOptions>): CloudVolume[] {
  const clouds: CloudVolume[] = [];
  const base = UPPER_LAYER_FLOOR + 10;
  const top = opt.ceiling - 10;
  if (top <= base) return clouds;

  for (let i = 0; i < opt.cloudBanks; i++) {
    const centre = {
      x: rng.range(-opt.sizeX / 2, opt.sizeX / 2),
      y: rng.range(base, top),
      z: rng.range(-opt.sizeZ / 2, opt.sizeZ / 2),
    };
    const puffs = 2 + Math.floor(rng.next() * 3);
    for (let p = 0; p < puffs; p++) {
      const radius = rng.range(16, 30);
      clouds.push({
        pos: {
          x: centre.x + rng.range(-radius, radius),
          // Flattened: cloud spreads sideways far more than it stacks.
          y: centre.y + rng.range(-radius * 0.35, radius * 0.35),
          z: centre.z + rng.range(-radius, radius),
        },
        radius,
      });
    }
  }
  return clouds;
}

/** Rejection-sample points that sit in open air, spread around the arena. */
function generateSpawns(
  rng: Rng,
  opt: Required<GenerateOptions>,
  solids: Solid[],
  ground: (x: number, z: number) => number,
): Vec3[] {
  const spawns: Vec3[] = [];
  const clearance = 6;
  let attempts = 0;

  while (spawns.length < opt.spawnCount && attempts < opt.spawnCount * 200) {
    attempts++;
    const x = rng.range(-opt.sizeX / 2 + 20, opt.sizeX / 2 - 20);
    const z = rng.range(-opt.sizeZ / 2 + 20, opt.sizeZ / 2 - 20);
    // Spawn heights are measured from the ground, not from sea level, so a
    // spawn over a hill does not end up buried in it.
    const p: Vec3 = {
      x,
      y: ground(x, z) + rng.range(25, Math.min(110, opt.ceiling - 25 - opt.terrainHeight)),
      z,
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
