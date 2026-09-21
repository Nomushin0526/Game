import { describe, expect, it } from 'vitest';
import {
  areaGridFor,
  classifyDodge,
  DEFAULT_DECAY,
  MIN_SAMPLES,
  PlayerModel,
  type AreaGrid,
} from '../src/ai/learning/playerModel.ts';
import { MemoryModelStore, keyOf } from '../src/ai/learning/storage.ts';
import type { Vec3 } from '../src/sim/types.ts';

const GRID: AreaGrid = areaGridFor({ size: { x: 400, z: 400 }, floor: 0, ceiling: 150 });

/** Feed one statistic past the confidence gate without a loop at each call site. */
function soak(model: PlayerModel, pos: Vec3, seconds = MIN_SAMPLES * 2): void {
  model.observe(pos, seconds);
}

describe('area grid', () => {
  it('round-trips a position through its area', () => {
    const model = new PlayerModel(GRID);
    for (const pos of [
      { x: 0, y: 75, z: 0 },
      { x: -190, y: 5, z: 190 },
      { x: 190, y: 145, z: -190 },
    ]) {
      const area = model.areaOf(pos);
      expect(area).toBeGreaterThanOrEqual(0);
      // The centre of the area a point falls in must map back to that area.
      expect(model.areaOf(model.areaCentre(area))).toBe(area);
    }
  });

  it('rejects positions outside the arena', () => {
    const model = new PlayerModel(GRID);
    expect(model.areaOf({ x: 500, y: 75, z: 0 })).toBe(-1);
    expect(model.areaOf({ x: 0, y: 500, z: 0 })).toBe(-1);
    expect(model.areaOf({ x: 0, y: -10, z: 0 })).toBe(-1);
  });
});

describe('player model', () => {
  it('says nothing at all until it has seen enough', () => {
    const model = new PlayerModel(GRID);
    const somewhere = { x: 100, y: 40, z: 100 };

    expect(model.confident).toBe(false);
    expect(model.affinity(somewhere)).toBe(0);
    expect(model.haunts()).toEqual([]);
    expect(model.preferredRange()).toBeNull();
    expect(model.accuracy()).toBeNull();
    expect(model.preferredAltitude()).toBeNull();
    expect(model.dodgeLean()).toBe(0);
  });

  it('learns where a player spends its time', () => {
    const model = new PlayerModel(GRID);
    const favourite = { x: 150, y: 40, z: 150 };
    const elsewhere = { x: -150, y: 40, z: -150 };
    soak(model, favourite, 60);
    soak(model, elsewhere, 10);

    expect(model.confident).toBe(true);
    expect(model.affinity(favourite)).toBeCloseTo(1, 5);
    expect(model.affinity(elsewhere)).toBeLessThan(0.5);
    expect(model.areaOf(model.haunts()[0]!)).toBe(model.areaOf(favourite));
  });

  it('learns a one-sided dodge, and reports none when it is even', () => {
    const model = new PlayerModel(GRID);
    for (let i = 0; i < 200; i++) model.observeDodge('right');
    for (let i = 0; i < 20; i++) model.observeDodge('left');
    expect(model.dodgeLean()).toBeGreaterThan(0.5);

    const even = new PlayerModel(GRID);
    for (let i = 0; i < 100; i++) {
      even.observeDodge('left');
      even.observeDodge('right');
    }
    expect(even.dodgeLean()).toBeCloseTo(0, 5);
  });

  it('holds its tongue while the evidence is thin', () => {
    // Eight-to-four is a lean of 0.33 on what is basically a coin, so the
    // estimate is shrunk towards zero until the sample earns its confidence.
    const thin = new PlayerModel(GRID);
    for (let i = 0; i < 8; i++) thin.observeDodge('right');
    for (let i = 0; i < 4; i++) thin.observeDodge('left');
    expect(Math.abs(thin.dodgeLean())).toBeLessThan(0.2);

    const thick = new PlayerModel(GRID);
    for (let i = 0; i < 160; i++) thick.observeDodge('right');
    for (let i = 0; i < 80; i++) thick.observeDodge('left');
    // Same two-to-one split, far more of it, so it is allowed to mean more.
    expect(thick.dodgeLean()).toBeGreaterThan(thin.dodgeLean() * 1.5);
  });

  it('learns the range they shoot from and how often they hit', () => {
    const model = new PlayerModel(GRID);
    for (let i = 0; i < MIN_SAMPLES * 2; i++) model.observeShot(70, i % 4 === 0);
    expect(model.preferredRange()).toBeGreaterThan(60);
    expect(model.preferredRange()).toBeLessThan(81);
    expect(model.accuracy()).toBeCloseTo(0.25, 2);
  });

  it('learns where they turn up again after breaking contact', () => {
    const model = new PlayerModel(GRID);
    const bolthole = { x: -150, y: 110, z: 150 };
    // One recovery is an accident; the query holds out for a second.
    model.observeReacquire(bolthole);
    expect(model.predictReappearance(0)).toBeNull();

    model.observeReacquire(bolthole);
    const predicted = model.predictReappearance(0);
    expect(predicted).not.toBeNull();
    expect(model.areaOf(predicted!)).toBe(model.areaOf(bolthole));
  });

  it('fades what it knew, so a player who changes is followed', () => {
    const model = new PlayerModel(GRID);
    soak(model, { x: 150, y: 40, z: 150 }, 100);
    const before = model.samples;

    model.endRound();
    expect(model.roundsSeen).toBe(1);
    expect(model.samples).toBeCloseTo(before * DEFAULT_DECAY, 3);

    // Enough rounds of a new habit and the old one stops being the answer.
    const moved = { x: -150, y: 110, z: -150 };
    for (let round = 0; round < 40; round++) {
      soak(model, moved, 30);
      model.endRound();
    }
    expect(model.areaOf(model.haunts()[0]!)).toBe(model.areaOf(moved));
  });
});

describe('dodge classification', () => {
  // Shooter facing -Z, so its right is -X.
  const right: Vec3 = { x: -1, y: 0, z: 0 };

  it('reads a break as the side it went to', () => {
    expect(classifyDodge({ x: -20, y: 1, z: 0 }, right)).toBe('right');
    expect(classifyDodge({ x: 20, y: 1, z: 0 }, right)).toBe('left');
  });

  it('ignores ordinary flight, which is not a dodge', () => {
    expect(classifyDodge({ x: 0, y: 0, z: -30 }, right)).toBeNull();
    expect(classifyDodge({ x: 1, y: 1, z: 0 }, right)).toBeNull();
  });

  it('ignores a climb or a dive, which are navigation and not evasion', () => {
    // Measured: a runner heading for cover loses altitude, and counting that
    // as a dodge pulled the hunter's aim down and halved its hit rate.
    expect(classifyDodge({ x: 0, y: 30, z: 0 }, right)).toBeNull();
    expect(classifyDodge({ x: 0, y: -30, z: 0 }, right)).toBeNull();
  });
});

describe('model storage', () => {
  const key = { mapId: 'city01', playerId: 'p1' };

  it('round-trips a model without losing what it learned', async () => {
    const store = new MemoryModelStore();
    const model = new PlayerModel(GRID);
    soak(model, { x: 150, y: 40, z: 150 }, 50);
    for (let i = 0; i < MIN_SAMPLES * 2; i++) model.observeDodge('left');
    for (let i = 0; i < MIN_SAMPLES * 2; i++) model.observeShot(50, true);
    model.observeReacquire({ x: -150, y: 110, z: 150 });
    model.observeReacquire({ x: -150, y: 110, z: 150 });
    model.endRound();

    await store.save(key, model.toData());
    const restored = PlayerModel.fromData(GRID, await store.load(key));

    expect(restored.roundsSeen).toBe(model.roundsSeen);
    expect(restored.samples).toBeCloseTo(model.samples, 3);
    expect(restored.dodgeLean()).toEqual(model.dodgeLean());
    expect(restored.accuracy()).toBeCloseTo(model.accuracy()!, 5);
    expect(restored.preferredRange()).toBe(model.preferredRange());
    expect(restored.predictReappearance(0)).toEqual(model.predictReappearance(0));
  });

  it('keeps models apart by map and by player', async () => {
    const store = new MemoryModelStore();
    const a = new PlayerModel(GRID);
    soak(a, { x: 150, y: 40, z: 150 }, 50);

    await store.save(key, a.toData());
    expect(await store.load({ mapId: 'city01', playerId: 'p2' })).toBeNull();
    expect(await store.load({ mapId: 'other', playerId: 'p1' })).toBeNull();
    expect(await store.list()).toEqual([key]);
  });

  it('forgets one player, or everyone', async () => {
    const store = new MemoryModelStore();
    const other = { mapId: 'city01', playerId: 'p2' };
    await store.save(key, new PlayerModel(GRID).toData());
    await store.save(other, new PlayerModel(GRID).toData());

    await store.clear(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.load(other)).not.toBeNull();

    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('does not hand back a model that a later edit can reach into', async () => {
    const store = new MemoryModelStore();
    const model = new PlayerModel(GRID);
    soak(model, { x: 150, y: 40, z: 150 }, 50);
    await store.save(key, model.toData());

    // Whatever happens to the live model afterwards, the save stands.
    for (let round = 0; round < 50; round++) model.endRound();
    const restored = PlayerModel.fromData(GRID, await store.load(key));
    expect(restored.samples).toBeGreaterThan(model.samples);
  });

  it('discards data that does not fit the current area grid', () => {
    const model = new PlayerModel(GRID);
    soak(model, { x: 150, y: 40, z: 150 }, 50);
    const data = model.toData();

    // A model learned on a finer division describes places that no longer
    // exist, so it is dropped rather than half-imported.
    const finer: AreaGrid = { ...GRID, cells: GRID.cells * 2 };
    expect(PlayerModel.fromData(finer, data).confident).toBe(false);
    expect(PlayerModel.fromData(GRID, { ...data, version: 99 }).confident).toBe(false);
    expect(PlayerModel.fromData(GRID, null).confident).toBe(false);
  });

  it('builds a stable storage key', () => {
    expect(keyOf({ mapId: 'city01', playerId: 'p1' })).toBe('city01::p1');
  });
});
