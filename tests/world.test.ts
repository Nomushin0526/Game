import { beforeAll, describe, expect, it } from 'vitest';
import { loadMap } from '../src/maps/loader.ts';
import { CONFIG } from '../src/sim/config.ts';
import { distance } from '../src/sim/math.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { Rng } from '../src/sim/rng.ts';
import { neutralInput, type PlayerInput } from '../src/sim/types.ts';
import { World } from '../src/sim/world.ts';

const map = loadMap('city01');

beforeAll(async () => {
  await initPhysics();
});

/** A reproducible, noisy input stream — the point is that it is not neutral. */
function scriptedInputs(seed: number, ticks: number): PlayerInput[][] {
  const rng = new Rng(seed);
  const script: PlayerInput[][] = [];
  for (let t = 0; t < ticks; t++) {
    script.push([0, 1].map(() => ({
      move: { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) },
      aimYaw: rng.range(-Math.PI, Math.PI),
      aimPitch: rng.range(-1, 1),
      fire: rng.bool(0.3),
      boost: rng.bool(0.4),
    })));
  }
  return script;
}

function run(seed: number, script: PlayerInput[][]) {
  const world = new World({ map, seed });
  for (const inputs of script) world.step(inputs);
  const snapshot = world.snapshot();
  world.dispose();
  return snapshot;
}

describe('World', () => {
  it('spawns one hunter and one runner by default', () => {
    const world = new World({ map, seed: 1 });
    expect(world.entities.map((e) => e.team)).toEqual(['hunter', 'runner']);
    expect(world.entities.every((e) => e.hp === CONFIG.loadout[e.team].maxHp)).toBe(true);
    expect(world.entities.every((e) => e.boostFuel === CONFIG.flight.boostCapacity)).toBe(true);
    world.dispose();
  });

  it('keeps spawns at least minSpawnDistance apart', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const world = new World({ map, seed });
      const [a, b] = world.entities;
      expect(distance(a!.pos, b!.pos)).toBeGreaterThanOrEqual(CONFIG.rules.minSpawnDistance);
      world.dispose();
    }
  });

  it('spawns in clear air, not inside a building', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const world = new World({ map, seed });
      for (const e of world.entities) {
        expect(world.physics.isClear(e.pos, CONFIG.flight.bodyRadius)).toBe(true);
      }
      world.dispose();
    }
  });

  it('advances time in fixed steps', () => {
    const world = new World({ map, seed: 1 });
    world.stepFor(2);
    expect(world.tick).toBe(120);
    expect(world.time).toBeCloseTo(2, 9);
    world.dispose();
  });

  it('is deterministic: same seed and inputs give identical state', () => {
    const script = scriptedInputs(7, 600);
    expect(run(3, script)).toEqual(run(3, script));
  });

  it('diverges when the seed changes', () => {
    const script = scriptedInputs(7, 120);
    expect(run(3, script)).not.toEqual(run(4, script));
  });

  it('restores an exact snapshot and replays from it', () => {
    const script = scriptedInputs(11, 200);
    const world = new World({ map, seed: 5 });
    for (let t = 0; t < 100; t++) world.step(script[t]!);

    const mid = world.snapshot();
    for (let t = 100; t < 200; t++) world.step(script[t]!);
    const end = world.snapshot();

    world.restore(mid);
    for (let t = 100; t < 200; t++) world.step(script[t]!);
    expect(world.snapshot()).toEqual(end);
    world.dispose();
  });

  it('resets back to a fresh round', () => {
    const world = new World({ map, seed: 9 });
    const start = world.snapshot();
    world.stepFor(3, [{ ...neutralInput(), move: { x: 0, y: 0, z: 1 }, boost: true }]);
    expect(world.snapshot()).not.toEqual(start);

    world.reset();
    expect(world.snapshot()).toEqual(start);
    world.dispose();
  });

  it('treats missing inputs as neutral', () => {
    const world = new World({ map, seed: 1 });
    world.stepFor(1, []);
    expect(world.entities.every((e) => e.vel.x === 0 && e.vel.y === 0 && e.vel.z === 0)).toBe(true);
    world.dispose();
  });

  it('never lets an entity leave the arena, whatever the input', () => {
    const script = scriptedInputs(21, 1800);
    const world = new World({ map, seed: 2 });
    const r = CONFIG.flight.bodyRadius;
    for (const inputs of script) {
      world.step(inputs);
      for (const e of world.entities) {
        expect(Number.isFinite(e.pos.x + e.pos.y + e.pos.z)).toBe(true);
        expect(e.pos.x).toBeGreaterThanOrEqual(world.bounds.minX + r - 1e-6);
        expect(e.pos.x).toBeLessThanOrEqual(world.bounds.maxX - r + 1e-6);
        expect(e.pos.y).toBeGreaterThanOrEqual(world.bounds.minY + r - 1e-6);
        expect(e.pos.y).toBeLessThanOrEqual(world.bounds.maxY - r + 1e-6);
        expect(e.pos.z).toBeGreaterThanOrEqual(world.bounds.minZ + r - 1e-6);
        expect(e.pos.z).toBeLessThanOrEqual(world.bounds.maxZ - r + 1e-6);
      }
    }
    world.dispose();
  });

  it('emits collision events when a craft flies into a building', () => {
    const world = new World({ map, seed: 1 });
    // Park the hunter on a collision course with the central tower.
    const hunter = world.entity(0);
    hunter.pos = { x: 0, y: 40, z: -60 };
    // Yaw PI faces +Z, straight at the tower that straddles the origin.
    const charge = { ...neutralInput(), move: { x: 0, y: 0, z: 1 }, aimYaw: Math.PI, boost: true };
    const events = world.stepFor(3, [charge, neutralInput()]);

    expect(events.some((e) => e.type === 'collision' && e.entityId === 0)).toBe(true);
    expect(hunter.hp).toBeLessThan(CONFIG.loadout.hunter.maxHp);
    world.dispose();
  });
});
