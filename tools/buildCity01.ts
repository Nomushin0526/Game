/**
 * Authoring tool for `maps/city01.json`.
 *
 *   npx tsx tools/buildCity01.ts > maps/city01.json
 *
 * The layout is hand-designed, but the Y positions are computed against the
 * same `Terrain` the game loads, so nothing ends up floating over a valley or
 * buried in a hill. Re-run this after changing the terrain parameters.
 */

import { Terrain } from '../src/maps/terrain.ts';
import { tunnelSolids, type Solid, type TunnelDef } from '../src/maps/types.ts';

const SIZE = 400;
const CEILING = 150;
const TERRAIN = { resolution: 32, maxHeight: 20, seed: 4021, featureSize: 9, octaves: 4 };

const terrain = Terrain.fromDef(TERRAIN, SIZE, SIZE);
const solids: Solid[] = [];

/** Lowest ground under a footprint, so a slab never hangs off a slope. */
function baseUnder(x: number, z: number, width: number, depth: number): number {
  let min = Infinity;
  for (const dx of [-0.5, 0, 0.5]) {
    for (const dz of [-0.5, 0, 0.5]) {
      min = Math.min(min, terrain.heightAt(x + dx * width, z + dz * depth));
    }
  }
  return min;
}

/** Plant a box on the ground; `height` is measured above the surface. */
function onGround(x: number, z: number, w: number, h: number, d: number, tag: Solid['tag']): number {
  const embed = 3;
  const base = baseUnder(x, z, w, d);
  solids.push({
    shape: 'box',
    pos: { x, y: base - embed + (h + embed) / 2, z },
    size: { x: w, y: h + embed, z: d },
    tag,
  });
  return base + h;
}

const box = (x: number, y: number, z: number, w: number, h: number, d: number, tag: Solid['tag']): void => {
  solids.push({ shape: 'box', pos: { x, y, z }, size: { x: w, y: h, z: d }, tag });
};
const cyl = (x: number, y: number, z: number, radius: number, height: number, tag: Solid['tag']): void => {
  solids.push({ shape: 'cylinder', pos: { x, y, z }, radius, height, tag });
};

// --- Mid layer: a 5x5 downtown grid, tallest in the middle. ---
const heights = [
  [18, 26, 34, 26, 18],
  [26, 48, 72, 48, 26],
  [34, 72, 88, 72, 34],
  [26, 48, 72, 48, 26],
  [18, 26, 34, 26, 18],
];
const STEP = 62;
const roofs: number[][] = [];
for (let i = 0; i < 5; i++) {
  roofs.push([]);
  for (let j = 0; j < 5; j++) {
    const h = heights[i]![j]!;
    const x = (i - 2) * STEP;
    const z = (j - 2) * STEP;
    const w = 30 + ((i * 7 + j * 3) % 9);
    const d = 30 + ((i * 3 + j * 7) % 9);
    roofs[i]![j] = onGround(x, z, w, h, d, 'building');
  }
}

// Cranes on the four inner towers, jibs fanned out.
const craneCells: Array<[number, number, number]> = [
  [1, 1, 0.4], [1, 3, 2.1], [3, 1, 3.6], [3, 3, 5.2],
];
for (const [i, j, rotY] of craneCells) {
  const x = (i - 2) * STEP;
  const z = (j - 2) * STEP;
  const roof = roofs[i]![j]!;
  cyl(x, roof + 10, z, 1.3, 20, 'crane');
  solids.push({
    shape: 'box',
    pos: { x: x + Math.cos(rotY) * 6, y: roof + 20, z: z - Math.sin(rotY) * 6 },
    size: { x: 34, y: 1.6, z: 2.4 },
    rotY,
    tag: 'crane',
  });
}

// --- Sky walkways between the tall towers (mid-layer cover). ---
box(-31, 50, -62, 32, 2, 6, 'bridge');
box(31, 50, 62, 32, 2, 6, 'bridge');
box(0, 64, -31, 6, 2, 32, 'bridge');
box(0, 64, 31, 6, 2, 32, 'bridge');
box(-62, 40, -31, 6, 2, 32, 'bridge');
box(62, 40, 31, 6, 2, 32, 'bridge');

// --- Ground layer: low warehouses. ---
onGround(-155, -20, 40, 10, 70, 'building');
onGround(155, 20, 40, 10, 70, 'building');
onGround(-20, -155, 70, 12, 40, 'building');
onGround(20, 155, 70, 12, 40, 'building');
onGround(-120, 120, 46, 8, 46, 'building');
onGround(120, -120, 46, 8, 46, 'building');

// --- Ground layer: a covered passage running north-south through downtown. ---
const tunnel: TunnelDef = {
  pos: { x: 0, y: terrain.heightAt(0, 0) + 8, z: 0 },
  length: 150,
  width: 18,
  height: 13,
  thickness: 3,
  rotY: 0,
};
// Baked into plain solids here rather than left as a `tunnels` entry, so the
// map file stays a flat list of geometry.
solids.push(...tunnelSolids(tunnel));

// --- Ground layer: an elevated roadway crossing east-west on pillars. ---
const DECK_Y = 25;
box(0, DECK_Y, -96, 340, 2, 9, 'bridge');
for (let p = -4; p <= 4; p++) {
  const px = p * 38;
  const base = terrain.heightAt(px, -96);
  const height = DECK_Y - 1 - base;
  if (height > 2) cyl(px, base + height / 2, -96, 2, height, 'bridge');
}

// --- Ground layer: tree cover in the open ground between blocks. ---
const TREE_SPOTS: Array<[number, number]> = [
  [-95, -31], [-88, -8], [-100, 14], [-93, 36], [-31, -95], [-8, -100], [14, -92],
  [36, -97], [95, 31], [88, 8], [100, -14], [93, -36], [31, 95], [8, 100], [-14, 92],
  [-36, 97], [-150, 60], [-142, 82], [-160, 100], [150, -60], [142, -82], [160, -100],
  [-170, -150], [-148, -168], [170, 150], [148, 168], [62, -31], [-62, 31],
];
for (const [x, z] of TREE_SPOTS) {
  const base = terrain.heightAt(x, z);
  cyl(x, base + 3, z, 0.6, 6, 'tree');
  cyl(x, base + 8.5, z, 3.4, 5, 'tree');
}

// --- Upper layer: sparse floating platforms (90-150 m). ---
const FLOATERS: Array<[number, number, number, number, number]> = [
  [-90, 104, 90, 11, 6], [95, 112, -85, 9, 5], [0, 124, 0, 13, 6],
  [-120, 98, -110, 8, 5], [130, 130, 120, 10, 6], [60, 96, -150, 7, 4],
  [-55, 118, 140, 9, 5], [150, 101, -30, 8, 5],
];
for (const [x, y, z, radius, height] of FLOATERS) cyl(x, y, z, radius, height, 'floater');

// --- Spawns: measured from the ground so relief cannot bury them. ---
const SPAWN_SPOTS: Array<[number, number, number]> = [
  [-170, 55, -170], [170, 55, 170], [-170, 90, 170], [170, 90, -170],
  [0, 125, -175], [0, 125, 175], [-178, 28, 0], [178, 28, 0],
  [-100, 70, 160], [100, 70, -160],
];
const spawns = SPAWN_SPOTS.map(([x, above, z]) => ({
  x,
  y: Math.round((terrain.heightAt(x, z) + above) * 10) / 10,
  z,
}));

const map = {
  id: 'city01',
  name: 'Downtown 01',
  size: { x: SIZE, z: SIZE },
  ceiling: CEILING,
  floor: 0,
  terrain: TERRAIN,
  spawns,
  solids: solids.map(round),
};

/** Keep the JSON readable: one decimal is plenty at metre scale. */
function round(solid: Solid): Solid {
  const r = (n: number): number => Math.round(n * 10) / 10;
  const pos = { x: r(solid.pos.x), y: r(solid.pos.y), z: r(solid.pos.z) };
  return solid.shape === 'box'
    ? { ...solid, pos, size: { x: r(solid.size.x), y: r(solid.size.y), z: r(solid.size.z) } }
    : { ...solid, pos, radius: r(solid.radius), height: r(solid.height) };
}

process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
