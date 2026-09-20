import { describe, expect, it } from 'vitest';
import { builtinMapIds, loadMap, parseMap } from '../src/maps/loader.ts';
import { generateCityMap } from '../src/maps/generator.ts';

describe('map loader', () => {
  it('ships city01 as a built-in map', () => {
    expect(builtinMapIds()).toContain('city01');
    const map = loadMap('city01');
    expect(map.id).toBe('city01');
    expect(map.size).toEqual({ x: 400, z: 400 });
    expect(map.ceiling).toBe(150);
    expect(map.solids.length).toBeGreaterThan(0);
  });

  it('gives city01 the three altitude layers from the design', () => {
    const map = loadMap('city01');
    const topOf = (s: (typeof map.solids)[number]) =>
      s.shape === 'box' ? s.pos.y + s.size.y / 2 : s.pos.y + s.height / 2;

    expect(map.solids.some((s) => topOf(s) <= 30)).toBe(true);
    expect(map.solids.some((s) => topOf(s) > 30 && topOf(s) <= 90)).toBe(true);
    expect(map.solids.some((s) => topOf(s) > 90)).toBe(true);
  });

  it('keeps every solid inside the arena', () => {
    const map = loadMap('city01');
    for (const s of map.solids) {
      const half = s.shape === 'box' ? s.size.x / 2 : s.radius;
      expect(Math.abs(s.pos.x) + half).toBeLessThanOrEqual(map.size.x / 2);
      expect(Math.abs(s.pos.z) + half).toBeLessThanOrEqual(map.size.z / 2);
      const top = s.shape === 'box' ? s.pos.y + s.size.y / 2 : s.pos.y + s.height / 2;
      expect(top).toBeLessThanOrEqual(map.ceiling);
    }
  });

  it('rejects malformed maps instead of silently accepting them', () => {
    expect(() => loadMap('nope')).toThrow(/Unknown map/);
    expect(() => parseMap({ id: 'x', size: { x: 1 }, ceiling: 10, spawns: [] })).toThrow();
    expect(() =>
      parseMap({ id: 'x', size: { x: 10, z: 10 }, ceiling: 10, spawns: [{ x: 0, y: 0, z: 0 }] }),
    ).toThrow(/at least 2 spawn points/);
    expect(() =>
      parseMap({
        id: 'x',
        size: { x: 10, z: 10 },
        ceiling: -5,
        spawns: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
      }),
    ).toThrow(/ceiling/);
  });
});

describe('generateCityMap', () => {
  it('is deterministic for a given seed', () => {
    expect(generateCityMap(1234)).toEqual(generateCityMap(1234));
  });

  it('produces different cities for different seeds', () => {
    expect(generateCityMap(1)).not.toEqual(generateCityMap(2));
  });

  it('always yields a usable map', () => {
    for (const seed of [1, 2, 3, 17, 99, 12345]) {
      const map = generateCityMap(seed);
      expect(map.spawns.length).toBeGreaterThanOrEqual(2);
      expect(map.solids.length).toBeGreaterThan(0);
      for (const spawn of map.spawns) {
        expect(spawn.y).toBeGreaterThan(0);
        expect(spawn.y).toBeLessThan(map.ceiling);
        expect(Math.abs(spawn.x)).toBeLessThan(map.size.x / 2);
        expect(Math.abs(spawn.z)).toBeLessThan(map.size.z / 2);
      }
    }
  });

  it('honours generation options', () => {
    const map = generateCityMap(5, { sizeX: 200, sizeZ: 200, gridCells: 4, floaterCount: 0 });
    expect(map.size).toEqual({ x: 200, z: 200 });
    expect(map.solids.some((s) => s.tag === 'floater')).toBe(false);
  });
});
