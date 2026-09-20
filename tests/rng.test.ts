import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng.ts';

describe('Rng', () => {
  it('produces the same stream for the same seed', () => {
    const a = Array.from({ length: 50 }, () => new Rng(12345).next());
    expect(new Set(a).size).toBe(1);

    const first = new Rng(7);
    const second = new Rng(7);
    for (let i = 0; i < 100; i++) expect(first.next()).toBe(second.next());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const differences = Array.from({ length: 20 }, () => a.next() !== b.next());
    expect(differences.every(Boolean)).toBe(true);
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('respects range and int bounds', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 1000; i++) {
      const r = rng.range(-5, 5);
      expect(r).toBeGreaterThanOrEqual(-5);
      expect(r).toBeLessThan(5);

      const n = rng.int(2, 4);
      expect([2, 3, 4]).toContain(n);
    }
  });

  it('round-trips through save/restore', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 10; i++) rng.next();
    const state = rng.save();
    const expected = Array.from({ length: 5 }, () => rng.next());

    rng.restore(state);
    expect(Array.from({ length: 5 }, () => rng.next())).toEqual(expected);
  });

  it('shuffles deterministically and keeps every element', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new Rng(11).shuffle([...items]);
    const b = new Rng(11).shuffle([...items]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });
});
