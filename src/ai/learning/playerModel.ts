/**
 * What the CPU remembers about an opponent between rounds (DESIGN.md 7.2).
 *
 * Deliberately statistics rather than machine learning: counts in small arrays,
 * cheap to update every tick, cheap to serialise, and readable enough that the
 * result screen can tell a player what the CPU thinks of them. Nothing here
 * allocates per tick and nothing touches the DOM, so it runs the same in the
 * browser, under Node and in the batch tool.
 *
 * The one rule that matters: **it may only record what the AI could actually
 * see.** DESIGN.md 7.1 forbids the CPU from cheating, and a model fed the
 * opponent's true position every tick would be exactly that — it would know
 * where you were hiding because it watched you hide through a wall. Callers
 * pass observations only while perception has genuine contact, which is why
 * `observe()` takes an already-seen position rather than an entity.
 */

import type { Vec3 } from '../../sim/types.ts';

/** How the arena is divided up for the occupancy and transition statistics. */
export interface AreaGrid {
  /** Cells along X and Z. */
  cells: number;
  /** Altitude bands, stacked from the floor to the ceiling. */
  bands: number;
  sizeX: number;
  sizeZ: number;
  floor: number;
  ceiling: number;
}

/**
 * Very coarse on purpose.
 *
 * These are habits, not positions: 4x2x4 over a 400 m arena makes each cell
 * 100 m across and 75 m tall — "the north-east quarter, low". It started at
 * 8x3x8 and that was measurably too fine: the statistic search depends on is a
 * pair of areas, so 192 areas means 36,864 possible pairs, and across sixteen
 * matches almost no pair was ever seen twice. Nothing learned, so nothing
 * changed. At 32 areas the same evidence actually lands in the same bucket,
 * which is the whole difference between a model and a list of coincidences.
 */
export const DEFAULT_AREAS: Omit<AreaGrid, 'sizeX' | 'sizeZ' | 'floor' | 'ceiling'> = {
  cells: 4,
  bands: 2,
};

/**
 * Which way a craft broke when it was shot at.
 *
 * Lateral only. Vertical was tried and had to go: measured against a runner
 * with no vertical habit at all the model still read "down (-0.31)", because
 * over the third of a second being judged the dominant vertical movement is
 * not evasion but descending towards the city, where all the cover is. It is
 * navigation wearing a dodge's clothes, and aiming at it cost the hunter half
 * its hit rate.
 */
export type DodgeAxis = 'left' | 'right';
const DODGES: readonly DodgeAxis[] = ['left', 'right'];

/** Buckets for the engagement-range histogram, in metres. */
const RANGE_BUCKET = 20;
const RANGE_BUCKETS = 8;

export interface PlayerModelData {
  version: number;
  /** Rounds this model has been fed. Used to gate acting on thin evidence. */
  rounds: number;
  occupancy: number[];
  /** Flattened `areas x areas` transition counts. */
  transitions: number[];
  dodges: number[];
  ranges: number[];
  /** Counts per area of where contact resumed after a genuine loss. */
  reappearances: number[];
  shots: number;
  hits: number;
}

const VERSION = 1;

/**
 * Minimum observations before a statistic is allowed to steer anything.
 *
 * Without this the first sighting of a round becomes "they always go there",
 * and the CPU chases a single data point around the map.
 */
export const MIN_SAMPLES = 12;

/**
 * How long contact must be gone before it counts as having lost someone.
 *
 * Without a threshold this statistic is mostly flicker: a craft crossing
 * behind a building breaks the sight line for a fraction of a second and
 * "reappears" in the area it never left, which teaches the hunter to search
 * where it is already standing. Two seconds is long enough that the runner
 * had to have gone somewhere.
 */
export const LOST_CONTACT_SECONDS = 2;

/**
 * How much of the model survives a round.
 *
 * Started at 0.85, which over sixteen rounds leaves 7% of the first round —
 * fine for "they have started playing high", fatal for a statistic that needs
 * two observations of the same thing before it will act. 0.95 still forgets a
 * player who changes, over something like twenty rounds, without erasing the
 * evidence before it can be used.
 */
export const DEFAULT_DECAY = 0.95;

/**
 * How long after a shot the target's break is judged, seconds.
 *
 * The first attempt compared velocity between adjacent ticks, which measures
 * acceleration noise: over 1/60 s a jinking craft's velocity barely moves, and
 * the samples cancelled out to "no clear habit" no matter how much was
 * recorded. A third of a second is long enough for an actual evasive move and
 * short enough to still be a response to that shot.
 */
export const DODGE_WINDOW_SECONDS = 0.35;

/**
 * How lopsided a habit must be before the AI will aim at it.
 *
 * This gate is the difference between the feature being useful and being a
 * regression. A hunter that already lands a third of its shots is hitting near
 * the centre of a 1.8 m target, so a systematic offset of even a metre turns
 * marginal hits into misses — measured, acting on a lean of 0.06 cost a hard
 * CPU ten points of accuracy. Below this the correct correction is none.
 */
export const DODGE_ACT_THRESHOLD = 0.25;

export class PlayerModel {
  readonly grid: AreaGrid;
  /** Seconds observed in each area. */
  private readonly occupancy: Float32Array;
  /** `from * areaCount + to` counts of area-to-area moves. */
  private readonly transitions: Float32Array;
  private readonly dodges: Float32Array;
  private readonly ranges: Float32Array;
  /**
   * Where contact resumed, after genuinely losing them.
   *
   * Two earlier shapes of this failed, and both failures are the reason it
   * looks like this:
   *
   * 1. An occupancy heatmap. It can only be fed while the runner is
   *    **visible**, so it learns where a player is *exposed*, not where they
   *    go to hide — and where they are exposed is mostly where the hunter
   *    already was. Searching it sent the hunter back where it had just been,
   *    and measured worse than no learning at all.
   * 2. `lostArea -> foundArea` pairs. The right idea, far too ambitious for
   *    the data rate: a real loss-and-recovery happens about once a round, and
   *    32 areas means 1,024 possible pairs, so across eight rounds no pair was
   *    ever seen twice and the model never said anything.
   *
   * This is the marginal of that table — "when I lose you, you turn up in the
   * north-east" — which is 32 buckets instead of 1,024 and so actually
   * converges in the handful of matches DESIGN.md 9 asks for.
   */
  private readonly reappearances: Float32Array;
  private shots = 0;
  private hits = 0;
  private rounds = 0;

  /** Area the opponent was last seen in, for the transition counts. */
  private lastArea = -1;

  constructor(grid: AreaGrid) {
    this.grid = grid;
    const count = this.areaCount;
    this.occupancy = new Float32Array(count);
    this.transitions = new Float32Array(count * count);
    this.dodges = new Float32Array(DODGES.length);
    this.ranges = new Float32Array(RANGE_BUCKETS);
    this.reappearances = new Float32Array(count);
  }

  get areaCount(): number {
    return this.grid.cells * this.grid.cells * this.grid.bands;
  }

  /** Total seconds of observation, which is what "do I know this player" means. */
  get samples(): number {
    let total = 0;
    for (const value of this.occupancy) total += value;
    return total;
  }

  get roundsSeen(): number {
    return this.rounds;
  }

  /** True once there is enough here to be worth acting on. */
  get confident(): boolean {
    return this.samples >= MIN_SAMPLES;
  }

  /**
   * Record a tick of genuine contact.
   *
   * `dt` rather than a count so the statistics mean seconds and stay
   * comparable across tick rates.
   */
  observe(pos: Vec3, dt: number): void {
    const area = this.areaOf(pos);
    if (area < 0) return;
    this.occupancy[area] += dt;

    if (this.lastArea >= 0 && this.lastArea !== area) {
      this.transitions[this.lastArea * this.areaCount + area] += 1;
    }
    this.lastArea = area;
  }

  /**
   * Record which way they broke under fire.
   *
   * Only meaningful while they know they are being shot at, so the caller
   * decides when that is; this just counts.
   */
  observeDodge(axis: DodgeAxis): void {
    this.dodges[DODGES.indexOf(axis)] += 1;
  }

  /** Record the distance they chose to shoot from. */
  observeShot(range: number, hit: boolean): void {
    this.shots += 1;
    if (hit) this.hits += 1;
    const bucket = Math.min(RANGE_BUCKETS - 1, Math.floor(range / RANGE_BUCKET));
    this.ranges[bucket] += 1;
  }

  /**
   * Close a round: fade what came before.
   *
   * DESIGN.md asks for old data to matter less, and the reason is that players
   * change. A flat average over twenty rounds cannot notice that someone has
   * started playing high; a decayed one is mostly the last few rounds.
   */
  endRound(decay = DEFAULT_DECAY): void {
    this.rounds += 1;
    this.lastArea = -1;
    scaleAll(this.occupancy, decay);
    scaleAll(this.transitions, decay);
    scaleAll(this.dodges, decay);
    scaleAll(this.ranges, decay);
    scaleAll(this.reappearances, decay);
    this.shots *= decay;
    this.hits *= decay;
  }

  /** Contact resumed after a genuine loss: this is where they turned up. */
  observeReacquire(pos: Vec3): void {
    const area = this.areaOf(pos);
    if (area >= 0) this.reappearances[area] += 1;
  }

  /**
   * Somewhere this player tends to turn up again after vanishing.
   *
   * Sampled from the top few rather than always the best, so a learned
   * opponent does not face a hunter that flies the identical search every
   * time — which would be both obvious and trivially exploitable. `pick` is
   * the caller's random number, so the AI's own seeded stream stays the only
   * source of randomness in the simulation.
   */
  predictReappearance(pick: number): Vec3 | null {
    let total = 0;
    for (const value of this.reappearances) total += value;
    // Two recoveries is the least that can distinguish a habit from an
    // accident, and is about two rounds' worth of evidence.
    if (total < 2) return null;

    const ranked = Array.from(this.reappearances, (value, index) => ({ value, index }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    if (ranked.length === 0) return null;

    const chosen = ranked[Math.min(ranked.length - 1, Math.floor(pick * ranked.length))]!;
    return this.areaCentre(chosen.index);
  }

  /** Places this player has turned up again, best first. For the result screen. */
  boltholes(limit = 3): Vec3[] {
    return Array.from(this.reappearances, (value, index) => ({ value, index }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
      .map((entry) => this.areaCentre(entry.index));
  }

  /** Call between rounds without ending one, e.g. on a respawn. */
  resetTrail(): void {
    this.lastArea = -1;
  }

  // ---- queries -----------------------------------------------------------

  /**
   * How much this player likes an area, 0..1 against their favourite.
   *
   * Returns 0 everywhere until there is enough evidence, so callers can add it
   * to a score without a special case for a fresh model.
   */
  affinity(pos: Vec3): number {
    if (!this.confident) return 0;
    const area = this.areaOf(pos);
    if (area < 0) return 0;
    let peak = 0;
    for (const value of this.occupancy) if (value > peak) peak = value;
    return peak > 0 ? this.occupancy[area]! / peak : 0;
  }

  /** The areas this player spends most of their time in, best first. */
  haunts(limit = 5): Vec3[] {
    if (!this.confident) return [];
    const ranked = Array.from(this.occupancy, (value, index) => ({ value, index }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
    return ranked.map((entry) => this.areaCentre(entry.index));
  }

  /**
   * Where they tend to go next from here.
   *
   * The Markov step from DESIGN.md 7.2: given the area they were last seen in,
   * the most frequent onward move. Null when the trail is too thin, which is
   * the normal answer for most of the first match.
   */
  predictNext(from: Vec3): Vec3 | null {
    if (!this.confident) return null;
    const area = this.areaOf(from);
    if (area < 0) return null;

    const base = area * this.areaCount;
    let best = -1;
    let bestCount = 0;
    let total = 0;
    for (let to = 0; to < this.areaCount; to++) {
      const count = this.transitions[base + to]!;
      total += count;
      if (count > bestCount) {
        bestCount = count;
        best = to;
      }
    }
    // One or two observed moves out of an area is a coincidence, not a habit.
    if (best < 0 || total < 3) return null;
    return this.areaCentre(best);
  }

  /**
   * Which way they break under fire, as a signed lean in -1..1.
   *
   * Positive means they favour the shooter's right. Used to bias a lead shot
   * towards where they are about to be rather than where they are.
   */
  dodgeLean(): number {
    const left = this.dodges[0]!;
    const right = this.dodges[1]!;
    // Shrunk towards zero rather than gated on a sample count. A hard
    // threshold means the first twelve observations say nothing and the
    // thirteenth can say "always right" — eight-to-four is a lean of 0.33 on
    // evidence that is basically a coin. Dividing by `total + MIN_SAMPLES`
    // instead makes early evidence weak and lets it strengthen as it earns it.
    return (right - left) / (left + right + MIN_SAMPLES);
  }

  /** The distance they like to shoot from, or null if not yet clear. */
  preferredRange(): number | null {
    let total = 0;
    for (const value of this.ranges) total += value;
    if (total < MIN_SAMPLES) return null;

    let best = 0;
    for (let i = 1; i < RANGE_BUCKETS; i++) {
      if (this.ranges[i]! > this.ranges[best]!) best = i;
    }
    return (best + 0.5) * RANGE_BUCKET;
  }

  /** Their hit rate, or null while the sample is too small to mean anything. */
  accuracy(): number | null {
    return this.shots >= MIN_SAMPLES ? this.hits / this.shots : null;
  }

  /** The altitude band they favour, as a height in metres, or null. */
  preferredAltitude(): number | null {
    if (!this.confident) return null;
    const perBand = new Float32Array(this.grid.bands);
    for (let i = 0; i < this.occupancy.length; i++) {
      perBand[Math.floor(i / (this.grid.cells * this.grid.cells))]! += this.occupancy[i]!;
    }
    let best = 0;
    for (let b = 1; b < perBand.length; b++) if (perBand[b]! > perBand[best]!) best = b;
    const span = (this.grid.ceiling - this.grid.floor) / this.grid.bands;
    return this.grid.floor + (best + 0.5) * span;
  }

  // ---- area maths --------------------------------------------------------

  /** Index of the area containing `pos`, or -1 when it is outside the arena. */
  areaOf(pos: Vec3): number {
    const { cells, bands, sizeX, sizeZ, floor, ceiling } = this.grid;
    const ix = Math.floor(((pos.x + sizeX / 2) / sizeX) * cells);
    const iz = Math.floor(((pos.z + sizeZ / 2) / sizeZ) * cells);
    const iy = Math.floor(((pos.y - floor) / (ceiling - floor)) * bands);
    if (ix < 0 || ix >= cells || iz < 0 || iz >= cells || iy < 0 || iy >= bands) return -1;
    return iy * cells * cells + iz * cells + ix;
  }

  /** Centre of an area, which is what the AI actually flies to. */
  areaCentre(index: number): Vec3 {
    const { cells, bands, sizeX, sizeZ, floor, ceiling } = this.grid;
    const iy = Math.floor(index / (cells * cells));
    const rest = index - iy * cells * cells;
    const iz = Math.floor(rest / cells);
    const ix = rest - iz * cells;
    return {
      x: -sizeX / 2 + ((ix + 0.5) / cells) * sizeX,
      y: floor + ((iy + 0.5) / bands) * (ceiling - floor),
      z: -sizeZ / 2 + ((iz + 0.5) / cells) * sizeZ,
    };
  }

  // ---- persistence -------------------------------------------------------

  toData(): PlayerModelData {
    return {
      version: VERSION,
      rounds: this.rounds,
      occupancy: Array.from(this.occupancy),
      transitions: Array.from(this.transitions),
      dodges: Array.from(this.dodges),
      ranges: Array.from(this.ranges),
      reappearances: Array.from(this.reappearances),
      shots: this.shots,
      hits: this.hits,
    };
  }

  /**
   * Rebuild from stored data.
   *
   * Anything whose shape does not match the current area grid is discarded
   * rather than patched: a model learned on a different map division describes
   * places that no longer exist, and half-importing it would be worse than
   * starting again.
   */
  static fromData(grid: AreaGrid, data: PlayerModelData | null | undefined): PlayerModel {
    const model = new PlayerModel(grid);
    if (!data || data.version !== VERSION) return model;
    if (data.occupancy.length !== model.areaCount) return model;
    if (data.transitions.length !== model.areaCount * model.areaCount) return model;

    model.occupancy.set(data.occupancy);
    model.transitions.set(data.transitions);
    model.dodges.set(data.dodges);
    model.ranges.set(data.ranges);
    if (data.reappearances?.length === model.reappearances.length) {
      model.reappearances.set(data.reappearances);
    }
    model.shots = data.shots;
    model.hits = data.hits;
    model.rounds = data.rounds;
    return model;
  }
}

/**
 * What the model has worked out, in words a player can read.
 *
 * DESIGN.md 7.2 asks for this on the result screen, and it doubles as the
 * honest disclosure: "where you get spotted" is named that way rather than
 * "where you hide", because a sighting-fed statistic can only ever describe
 * the places you were visible.
 */
export function describeModel(model: PlayerModel): string[] {
  const lines: string[] = [];
  if (model.roundsSeen === 0 && !model.confident) return lines;

  const lean = model.dodgeLean();
  if (Math.abs(lean) >= 0.15) {
    lines.push(`射線に入ると${lean > 0 ? '右' : '左'}に避けがち`);
  }

  const range = model.preferredRange();
  if (range !== null) lines.push(`撃つのは ${range.toFixed(0)}m くらいの距離が多い`);

  const altitude = model.preferredAltitude();
  if (altitude !== null) lines.push(`見つかるのは高度 ${altitude.toFixed(0)}m あたりが多い`);

  const accuracy = model.accuracy();
  if (accuracy !== null) lines.push(`命中率 ${(accuracy * 100).toFixed(0)}%`);

  if (model.boltholes(1).length > 0) {
    const spot = model.boltholes(1)[0]!;
    lines.push(
      `見失ったあと再発見されやすい場所: (${spot.x.toFixed(0)}, ${spot.y.toFixed(0)}, ${spot.z.toFixed(0)})`,
    );
  }
  return lines;
}

/** Build the area grid a map implies. */
export function areaGridFor(map: {
  size: { x: number; z: number };
  floor: number;
  ceiling: number;
}): AreaGrid {
  return {
    ...DEFAULT_AREAS,
    sizeX: map.size.x,
    sizeZ: map.size.z,
    floor: map.floor,
    ceiling: map.ceiling,
  };
}

/**
 * Classify a dodge from the craft's own frame.
 *
 * `velocity` is the movement being judged and `forward`/`right` the frame of
 * whoever is shooting, so "left" means left from the shooter's point of view —
 * which is the frame the correction is applied in later.
 */
export function classifyDodge(
  velocity: Vec3,
  right: Vec3,
  minSpeed = 4,
): DodgeAxis | null {
  const lateral = velocity.x * right.x + velocity.y * right.y + velocity.z * right.z;
  if (Math.abs(lateral) < minSpeed) return null;
  return lateral > 0 ? 'right' : 'left';
}

function scaleAll(values: Float32Array, factor: number): void {
  for (let i = 0; i < values.length; i++) values[i]! *= factor;
}
