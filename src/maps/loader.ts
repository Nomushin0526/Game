/**
 * Map loading and validation.
 *
 * Maps are plain JSON under `maps/` at the repository root. They are pulled in
 * through the module graph rather than fetched, so the exact same call works in
 * the browser (Vite inlines the JSON), in Vitest and under `tsx`.
 */

import city01 from '../../maps/city01.json';
import { Terrain, type TerrainDef } from './terrain.ts';
import { tunnelSolids, type CloudVolume, type MapData, type Solid, type TunnelDef } from './types.ts';

const BUILTIN_MAPS: Record<string, unknown> = {
  city01,
};

export function builtinMapIds(): string[] {
  return Object.keys(BUILTIN_MAPS);
}

export function loadMap(id: string): MapData {
  const raw = BUILTIN_MAPS[id];
  if (!raw) {
    throw new Error(`Unknown map "${id}". Known maps: ${builtinMapIds().join(', ')}`);
  }
  return parseMap(raw);
}

/**
 * Validate an arbitrary object into a `MapData`. Throws on anything malformed.
 *
 * Two things are resolved here so that nothing downstream has to: terrain
 * definitions become a sampled `Terrain`, and tunnels become plain solids.
 */
export function parseMap(raw: unknown): MapData {
  if (typeof raw !== 'object' || raw === null) throw new Error('Map must be an object');
  const m = raw as Record<string, unknown>;

  const id = requireString(m, 'id');
  const name = typeof m.name === 'string' ? m.name : id;
  const size = m.size as { x?: unknown; z?: unknown } | undefined;
  if (!size || typeof size.x !== 'number' || typeof size.z !== 'number') {
    throw new Error(`Map "${id}": size must be { x: number, z: number }`);
  }
  const ceiling = requireNumber(m, 'ceiling', id);
  const floor = typeof m.floor === 'number' ? m.floor : 0;
  if (ceiling <= floor) throw new Error(`Map "${id}": ceiling must be above floor`);

  const spawns = Array.isArray(m.spawns) ? m.spawns.map((s, i) => requireVec3(s, `${id}.spawns[${i}]`)) : [];
  if (spawns.length < 2) throw new Error(`Map "${id}": needs at least 2 spawn points`);

  const solids = Array.isArray(m.solids) ? m.solids.map((s, i) => parseSolid(s, `${id}.solids[${i}]`)) : [];

  const terrain = m.terrain === undefined
    ? undefined
    : Terrain.fromDef(parseTerrain(m.terrain, id), size.x, size.z);
  if (terrain && terrain.maxHeight > ceiling - floor) {
    throw new Error(`Map "${id}": terrain maxHeight rises above the ceiling`);
  }

  if (Array.isArray(m.tunnels)) {
    m.tunnels.forEach((t, i) => solids.push(...tunnelSolids(parseTunnel(t, `${id}.tunnels[${i}]`))));
  }

  const clouds = Array.isArray(m.clouds)
    ? m.clouds.map((c, i) => parseCloud(c, `${id}.clouds[${i}]`))
    : [];

  return { id, name, size: { x: size.x, z: size.z }, ceiling, floor, terrain, spawns, solids, clouds };
}

function parseCloud(raw: unknown, where: string): CloudVolume {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: must be an object`);
  const c = raw as Record<string, unknown>;
  const radius = c.radius;
  if (typeof radius !== 'number' || !(radius > 0)) {
    throw new Error(`${where}: radius must be a positive number`);
  }
  return { pos: requireVec3(c.pos, `${where}.pos`), radius };
}

function parseTerrain(raw: unknown, id: string): TerrainDef {
  if (typeof raw !== 'object' || raw === null) throw new Error(`Map "${id}": terrain must be an object`);
  const t = raw as Record<string, unknown>;

  const resolution = t.resolution;
  if (typeof resolution !== 'number' || !Number.isInteger(resolution) || resolution < 1) {
    throw new Error(`Map "${id}": terrain.resolution must be a positive integer`);
  }
  const maxHeight = t.maxHeight;
  if (typeof maxHeight !== 'number' || maxHeight < 0) {
    throw new Error(`Map "${id}": terrain.maxHeight must be a non-negative number`);
  }

  const def: TerrainDef = { resolution, maxHeight };
  if (typeof t.seed === 'number') def.seed = t.seed;
  if (typeof t.featureSize === 'number') def.featureSize = t.featureSize;
  if (typeof t.octaves === 'number') def.octaves = t.octaves;

  if (t.heights !== undefined) {
    const expected = (resolution + 1) ** 2;
    if (!Array.isArray(t.heights) || t.heights.length !== expected) {
      throw new Error(`Map "${id}": terrain.heights must hold exactly ${expected} values`);
    }
    if (t.heights.some((h) => typeof h !== 'number' || h < 0 || h > 1)) {
      throw new Error(`Map "${id}": terrain.heights must all be numbers in 0..1`);
    }
    def.heights = t.heights as number[];
  }
  return def;
}

function parseTunnel(raw: unknown, where: string): TunnelDef {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: must be an object`);
  const t = raw as Record<string, unknown>;
  const pos = requireVec3(t.pos, `${where}.pos`);

  for (const key of ['length', 'width', 'height'] as const) {
    if (typeof t[key] !== 'number' || (t[key] as number) <= 0) {
      throw new Error(`${where}: ${key} must be a positive number`);
    }
  }
  return {
    pos,
    length: t.length as number,
    width: t.width as number,
    height: t.height as number,
    thickness: typeof t.thickness === 'number' ? t.thickness : undefined,
    rotY: typeof t.rotY === 'number' ? t.rotY : 0,
    floor: t.floor === true,
  };
}

function parseSolid(raw: unknown, where: string): Solid {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: must be an object`);
  const s = raw as Record<string, unknown>;
  const pos = requireVec3(s.pos, `${where}.pos`);
  const tag = typeof s.tag === 'string' ? (s.tag as Solid['tag']) : undefined;

  if (s.shape === 'cylinder') {
    if (typeof s.radius !== 'number' || typeof s.height !== 'number') {
      throw new Error(`${where}: cylinder needs numeric radius and height`);
    }
    return { shape: 'cylinder', pos, radius: s.radius, height: s.height, tag };
  }
  if (s.shape === 'box' || s.shape === undefined) {
    const size = requireVec3(s.size, `${where}.size`);
    const rotY = typeof s.rotY === 'number' ? s.rotY : 0;
    return { shape: 'box', pos, size, rotY, tag };
  }
  throw new Error(`${where}: unknown shape "${String(s.shape)}"`);
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Map: "${key}" must be a non-empty string`);
  return v;
}

function requireNumber(o: Record<string, unknown>, key: string, id: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Map "${id}": "${key}" must be a number`);
  return v;
}

function requireVec3(raw: unknown, where: string): { x: number; y: number; z: number } {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: must be {x,y,z}`);
  const v = raw as Record<string, unknown>;
  if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
    throw new Error(`${where}: must be {x,y,z} of numbers`);
  }
  return { x: v.x, y: v.y, z: v.z };
}
