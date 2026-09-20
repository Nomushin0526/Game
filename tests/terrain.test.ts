import { beforeAll, describe, expect, it } from 'vitest';
import { loadMap, parseMap } from '../src/maps/loader.ts';
import { generateHeights, Terrain } from '../src/maps/terrain.ts';
import { tunnelSolids } from '../src/maps/types.ts';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import type { MapData } from '../src/maps/types.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('generateHeights', () => {
  const options = { seed: 7, featureSize: 8, octaves: 4 };

  it('is deterministic for a seed', () => {
    expect(Array.from(generateHeights(33, options))).toEqual(
      Array.from(generateHeights(33, options)),
    );
  });

  it('differs for different seeds', () => {
    expect(Array.from(generateHeights(33, options))).not.toEqual(
      Array.from(generateHeights(33, { ...options, seed: 8 })),
    );
  });

  it('normalises to the full 0..1 range', () => {
    const heights = generateHeights(33, options);
    expect(Math.min(...heights)).toBeCloseTo(0, 6);
    expect(Math.max(...heights)).toBeCloseTo(1, 6);
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
  });

  it('is smooth: neighbouring vertices never jump the whole range', () => {
    const vertices = 33;
    const heights = generateHeights(vertices, options);
    let biggestStep = 0;
    for (let ix = 0; ix < vertices - 1; ix++) {
      for (let iz = 0; iz < vertices - 1; iz++) {
        const here = heights[ix * vertices + iz]!;
        biggestStep = Math.max(
          biggestStep,
          Math.abs(heights[(ix + 1) * vertices + iz]! - here),
          Math.abs(heights[ix * vertices + iz + 1]! - here),
        );
      }
    }
    expect(biggestStep).toBeLessThan(0.35);
  });
});

describe('Terrain sampling', () => {
  /** A 100x100 patch that ramps from 0 to 10 m along +Z only. */
  function ramp(): Terrain {
    const n = 3;
    const heights = new Float32Array(n * n);
    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) heights[ix * n + iz] = iz / (n - 1);
    }
    return new Terrain(n - 1, 10, 100, 100, heights);
  }

  it('maps the outer index to X and the inner to Z', () => {
    const t = ramp();
    expect(t.heightAt(-50, -50)).toBeCloseTo(0, 5);
    expect(t.heightAt(50, -50)).toBeCloseTo(0, 5);
    expect(t.heightAt(-50, 50)).toBeCloseTo(10, 5);
    expect(t.heightAt(50, 50)).toBeCloseTo(10, 5);
  });

  it('interpolates between vertices', () => {
    const t = ramp();
    expect(t.heightAt(0, 0)).toBeCloseTo(5, 5);
    expect(t.heightAt(0, -25)).toBeCloseTo(2.5, 5);
    expect(t.heightAt(0, 25)).toBeCloseTo(7.5, 5);
  });

  it('clamps to the edge outside the arena instead of falling away', () => {
    const t = ramp();
    expect(t.heightAt(-500, 500)).toBeCloseTo(10, 5);
    expect(t.heightAt(500, -500)).toBeCloseTo(0, 5);
  });

  it('reports its peak', () => {
    expect(ramp().peak()).toBeCloseTo(10, 5);
    expect(Terrain.flat(8, 100, 100).peak()).toBe(0);
  });

  it('rejects a heights buffer of the wrong size', () => {
    expect(() => new Terrain(4, 10, 100, 100, new Float32Array(10))).toThrow(/expected 25 heights/);
  });

  it('round-trips through its definition', () => {
    const original = Terrain.fromDef({ resolution: 8, maxHeight: 15, seed: 3 }, 200, 200);
    const restored = Terrain.fromDef(original.toDef(), 200, 200);
    for (const [x, z] of [[0, 0], [-80, 40], [55, -90]]) {
      expect(restored.heightAt(x!, z!)).toBeCloseTo(original.heightAt(x!, z!), 3);
    }
  });
});

describe('terrain physics', () => {
  /** Empty arena whose only geometry is the relief itself. */
  function terrainMap(terrain: Terrain): MapData {
    return {
      id: 'terrain-test',
      name: 'Terrain Test',
      size: { x: terrain.sizeX, z: terrain.sizeZ },
      ceiling: 150,
      floor: 0,
      terrain,
      spawns: [{ x: -100, y: 60, z: 0 }, { x: 100, y: 60, z: 0 }],
      solids: [],
    };
  }

  /** Where a ray straight down first meets the world. */
  function groundUnder(physics: PhysicsWorld, x: number, z: number): number | null {
    const hit = physics.raycast({ x, y: 140, z }, { x: 0, y: -1, z: 0 }, 200);
    return hit ? 140 - hit.distance : null;
  }

  it('puts the collision surface exactly where Terrain.heightAt says', () => {
    const terrain = Terrain.fromDef({ resolution: 32, maxHeight: 24, seed: 11 }, 400, 400);
    const physics = new PhysicsWorld(terrainMap(terrain));

    // Sample vertex centres, so bilinear interpolation and the collider's
    // triangulation are compared where they must agree exactly.
    for (const [x, z] of [[0, 0], [-150, 75], [120, -180], [-37.5, -37.5], [199, 199]]) {
      const surface = groundUnder(physics, x!, z!);
      expect(surface).not.toBeNull();
      expect(surface!).toBeCloseTo(terrain.heightAt(x!, z!), 1);
    }
    physics.dispose();
  });

  it('blocks line of sight through a hill', () => {
    const terrain = Terrain.fromDef({ resolution: 16, maxHeight: 40, seed: 5 }, 400, 400);
    const physics = new PhysicsWorld(terrainMap(terrain));

    // Fly the sightline at the midpoint of the ground profile along z = 0, so
    // it is above the valleys at both ends and below the ridges in between.
    let min = Infinity;
    let max = -Infinity;
    for (let x = -180; x <= 180; x += 5) {
      const h = terrain.heightAt(x, 0);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    expect(max - min).toBeGreaterThan(5);
    const y = (min + max) / 2;

    expect(physics.isBlocked({ x: -180, y, z: 0 }, { x: 180, y, z: 0 })).toBe(true);

    // Well above the peak there is nothing in the way.
    expect(physics.isBlocked({ x: -180, y: max + 20, z: 0 }, { x: 180, y: max + 20, z: 0 })).toBe(false);
    physics.dispose();
  });

  it('treats a sightline that runs underground as blocked', () => {
    const terrain = Terrain.fromDef({ resolution: 16, maxHeight: 40, seed: 5 }, 400, 400);
    const physics = new PhysicsWorld(terrainMap(terrain));
    const buried = { x: 0, y: terrain.heightAt(0, 0) - 5, z: 0 };

    // A height field has no underside, so this has to be answered by sampling
    // the terrain, not by asking the collider.
    expect(physics.isUnderground(buried)).toBe(true);
    expect(physics.isBlocked(buried, { x: 100, y: 80, z: 100 })).toBe(true);
    physics.dispose();
  });

  it('stops a craft flying into a hillside', () => {
    const terrain = Terrain.fromDef({ resolution: 32, maxHeight: 24, seed: 11 }, 400, 400);
    const physics = new PhysicsWorld(terrainMap(terrain));
    const surface = terrain.heightAt(0, 0);

    const hit = physics.sphereCast({ x: 0, y: surface + 40, z: 0 }, { x: 0, y: -1, z: 0 }, 60, 1.2);
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(surface, 1);
    expect(hit!.normal.y).toBeGreaterThan(0.5);
    physics.dispose();
  });

  it('reports points below the surface as not clear', () => {
    const terrain = Terrain.fromDef({ resolution: 32, maxHeight: 24, seed: 11 }, 400, 400);
    const physics = new PhysicsWorld(terrainMap(terrain));
    const surface = terrain.heightAt(-60, 60);

    expect(physics.isClear({ x: -60, y: surface - 4, z: 60 }, 1.2)).toBe(false);
    expect(physics.isClear({ x: -60, y: surface + 10, z: 60 }, 1.2)).toBe(true);
    physics.dispose();
  });
});

describe('tunnels', () => {
  const def = { pos: { x: 0, y: 10, z: 0 }, length: 100, width: 20, height: 12, thickness: 3 };

  it('expands into two walls and a roof with clear air between', () => {
    const solids = tunnelSolids(def);
    expect(solids).toHaveLength(3);
    expect(solids.every((s) => s.tag === 'tunnel')).toBe(true);

    const walls = solids.filter((s) => s.shape === 'box' && s.size.x === 3);
    expect(walls).toHaveLength(2);
    // Inner faces sit exactly on the requested clear width.
    expect(Math.abs(walls[0]!.pos.x)).toBeCloseTo((20 + 3) / 2, 6);
  });

  it('adds a floor slab only when asked', () => {
    expect(tunnelSolids(def)).toHaveLength(3);
    expect(tunnelSolids({ ...def, floor: true })).toHaveLength(4);
  });

  it('rotates the walls around the passage axis', () => {
    const rotated = tunnelSolids({ ...def, rotY: Math.PI / 2 });
    const walls = rotated.filter((s) => s.shape === 'box' && s.size.x === 3);
    // A quarter turn moves the side walls from the X axis onto the Z axis.
    for (const wall of walls) {
      expect(wall.pos.x).toBeCloseTo(0, 6);
      expect(Math.abs(wall.pos.z)).toBeCloseTo((20 + 3) / 2, 6);
    }
  });

  it('leaves the interior of a loaded tunnel flyable', () => {
    const map = parseMap({
      id: 'tunnel-test',
      size: { x: 400, z: 400 },
      ceiling: 150,
      spawns: [{ x: -100, y: 60, z: 0 }, { x: 100, y: 60, z: 0 }],
      solids: [],
      tunnels: [{ pos: { x: 0, y: 20, z: 0 }, length: 100, width: 20, height: 12 }],
    });
    const physics = new PhysicsWorld(map);

    // Down the middle of the passage is clear; the walls either side are not.
    expect(physics.isClear({ x: 0, y: 20, z: 0 }, 1.2)).toBe(true);
    expect(physics.isClear({ x: 11.5, y: 20, z: 0 }, 1.2)).toBe(false);
    expect(physics.isClear({ x: -11.5, y: 20, z: 0 }, 1.2)).toBe(false);
    // And the roof is overhead, so it is genuinely covered.
    expect(physics.isBlocked({ x: 0, y: 20, z: 0 }, { x: 0, y: 80, z: 0 })).toBe(true);
    physics.dispose();
  });
});

describe('terrain in map files', () => {
  it('rejects malformed terrain definitions', () => {
    const base = {
      id: 'x',
      size: { x: 100, z: 100 },
      ceiling: 100,
      spawns: [{ x: 0, y: 50, z: 0 }, { x: 10, y: 50, z: 0 }],
      solids: [],
    };
    expect(() => parseMap({ ...base, terrain: { resolution: 0, maxHeight: 5 } })).toThrow(/resolution/);
    expect(() => parseMap({ ...base, terrain: { resolution: 4, maxHeight: -1 } })).toThrow(/maxHeight/);
    expect(() => parseMap({ ...base, terrain: { resolution: 4, maxHeight: 5, heights: [0, 1] } }))
      .toThrow(/exactly 25 values/);
    expect(() =>
      parseMap({ ...base, terrain: { resolution: 1, maxHeight: 5, heights: [0, 1, 2, 0] } }),
    ).toThrow(/in 0\.\.1/);
    expect(() => parseMap({ ...base, terrain: { resolution: 4, maxHeight: 500 } }))
      .toThrow(/above the ceiling/);
  });

  it('accepts baked-in heights', () => {
    const map = parseMap({
      id: 'x',
      size: { x: 100, z: 100 },
      ceiling: 100,
      spawns: [{ x: 0, y: 50, z: 0 }, { x: 10, y: 50, z: 0 }],
      solids: [],
      terrain: { resolution: 1, maxHeight: 10, heights: [0, 0, 1, 1] },
    });
    // heights[ix * 2 + iz]: flat along Z, ramping along X.
    expect(map.terrain!.heightAt(-50, 0)).toBeCloseTo(0, 5);
    expect(map.terrain!.heightAt(50, 0)).toBeCloseTo(10, 5);
  });

  it('leaves terrain undefined when a map does not declare it', () => {
    expect(loadMap('city01').terrain).toBeDefined();
    const flat = parseMap({
      id: 'flat',
      size: { x: 100, z: 100 },
      ceiling: 100,
      spawns: [{ x: 0, y: 50, z: 0 }, { x: 10, y: 50, z: 0 }],
      solids: [],
    });
    expect(flat.terrain).toBeUndefined();
  });
});
