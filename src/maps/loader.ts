/**
 * Map loading and validation.
 *
 * Maps are plain JSON under `maps/` at the repository root. They are pulled in
 * through the module graph rather than fetched, so the exact same call works in
 * the browser (Vite inlines the JSON), in Vitest and under `tsx`.
 */

import city01 from '../../maps/city01.json';
import type { MapData, Solid } from './types.ts';

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

/** Validate an arbitrary object into a `MapData`. Throws on anything malformed. */
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

  return { id, name, size: { x: size.x, z: size.z }, ceiling, floor, spawns, solids };
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
