import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import type { MapData } from '../src/maps/types.ts';

const MAP: MapData = {
  id: 'physics-test',
  name: 'Physics Test',
  size: { x: 400, z: 400 },
  ceiling: 150,
  floor: 0,
  spawns: [
    { x: -100, y: 50, z: 0 },
    { x: 100, y: 50, z: 0 },
  ],
  solids: [
    { shape: 'box', pos: { x: 0, y: 50, z: 0 }, size: { x: 20, y: 20, z: 20 }, tag: 'building' },
    { shape: 'cylinder', pos: { x: 0, y: 120, z: 0 }, radius: 10, height: 6, tag: 'floater' },
  ],
};

let physics: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
  physics = new PhysicsWorld(MAP);
});

describe('PhysicsWorld', () => {
  it('reports a sphere cast hit with an outward-facing normal', () => {
    const hit = physics.sphereCast({ x: -50, y: 50, z: 0 }, { x: 1, y: 0, z: 0 }, 60, 1.2);
    expect(hit).not.toBeNull();
    // The -X face of the cube sits at x = -10; the sphere stops 1.2 m short.
    expect(hit!.distance).toBeCloseTo(50 - 10 - 1.2, 2);
    expect(hit!.normal.x).toBeCloseTo(-1, 3);
    expect(hit!.point.x).toBeCloseTo(-10, 2);
  });

  it('returns null when the sweep stops short of geometry', () => {
    expect(physics.sphereCast({ x: -50, y: 50, z: 0 }, { x: 1, y: 0, z: 0 }, 10, 1.2)).toBeNull();
  });

  it('accounts for the sphere radius', () => {
    const thin = physics.sphereCast({ x: -50, y: 50, z: 0 }, { x: 1, y: 0, z: 0 }, 60, 0.1);
    const fat = physics.sphereCast({ x: -50, y: 50, z: 0 }, { x: 1, y: 0, z: 0 }, 60, 5);
    expect(fat!.distance).toBeLessThan(thin!.distance);
  });

  it('ray casts against boxes and cylinders', () => {
    const box = physics.raycast({ x: -50, y: 50, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
    expect(box!.distance).toBeCloseTo(40, 2);

    const floater = physics.raycast({ x: 0, y: 200, z: 0 }, { x: 0, y: -1, z: 0 }, 200);
    expect(floater!.distance).toBeCloseTo(200 - 123, 2);
  });

  it('stops rays at the ground slab', () => {
    const hit = physics.raycast({ x: 30, y: 40, z: 30 }, { x: 0, y: -1, z: 0 }, 100);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(40, 2);
  });

  it('answers line-of-sight queries', () => {
    expect(physics.isBlocked({ x: -50, y: 50, z: 0 }, { x: 50, y: 50, z: 0 })).toBe(true);
    expect(physics.isBlocked({ x: -50, y: 90, z: 0 }, { x: 50, y: 90, z: 0 })).toBe(false);
    expect(physics.isBlocked({ x: -50, y: 90, z: 0 }, { x: -50, y: 90, z: 0 })).toBe(false);
  });

  it('answers clearance queries', () => {
    expect(physics.isClear({ x: 0, y: 50, z: 0 }, 1.2)).toBe(false);
    expect(physics.isClear({ x: 0, y: 90, z: 0 }, 1.2)).toBe(true);
    expect(physics.isClear({ x: 0, y: -1, z: 0 }, 1.2)).toBe(false);
  });
});
