/**
 * Seeded random number generator.
 *
 * `Math.random()` is banned everywhere in this project: replays, unit tests,
 * head-less batch runs and (later) reinforcement learning all depend on the
 * simulation being reproducible from a seed.
 */

/** mulberry32 — small, fast, good enough for gameplay and map generation. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Mix the seed so that 1, 2, 3 ... produce unrelated streams.
    this.state = (seed >>> 0) || 0x9e3779b9;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  /** Snapshot/restore, so a world can be saved mid-round and resumed exactly. */
  save(): number {
    return this.state;
  }

  restore(state: number): void {
    this.state = state >>> 0;
  }
}
