/**
 * Ground relief: a height field sampled on a regular grid over the arena.
 *
 * One `Terrain` instance is shared by physics (Rapier's heightfield collider),
 * rendering (a displaced plane) and map generation (placing buildings and
 * spawn points on the surface), so all three agree on where the ground is.
 *
 * The index layout matches Rapier's column-major heightfield exactly:
 * `heights[ix * vertices + iz]`, with `ix` walking +X and `iz` walking +Z,
 * both spanning the full arena from -size/2 to +size/2.
 */

import { Rng } from '../sim/rng.ts';

export interface TerrainDef {
  /** Cells per axis. The grid has `resolution + 1` vertices per axis. */
  resolution: number;
  /** Height of the highest possible peak, metres. */
  maxHeight: number;
  /** Seed for procedural relief. Ignored when `heights` is given. */
  seed?: number;
  /**
   * Feature size of the largest noise octave, in cells. Larger means broader,
   * smoother hills; smaller means choppier ground.
   */
  featureSize?: number;
  /** Number of noise octaves. Each adds finer detail at half the amplitude. */
  octaves?: number;
  /**
   * Explicit normalised heights (0..1) in the layout above,
   * `(resolution + 1)^2` values. Takes precedence over `seed`.
   */
  heights?: number[];
}

const DEFAULT_FEATURE_SIZE = 8;
const DEFAULT_OCTAVES = 4;

export class Terrain {
  /** Vertices per axis. */
  readonly vertices: number;
  /** Normalised 0..1 heights, `heights[ix * vertices + iz]`. */
  readonly heights: Float32Array;

  constructor(
    readonly resolution: number,
    readonly maxHeight: number,
    readonly sizeX: number,
    readonly sizeZ: number,
    heights: Float32Array,
  ) {
    this.vertices = resolution + 1;
    if (heights.length !== this.vertices * this.vertices) {
      throw new Error(
        `Terrain: expected ${this.vertices * this.vertices} heights, got ${heights.length}`,
      );
    }
    this.heights = heights;
  }

  /** Build from a map definition, generating relief when none was supplied. */
  static fromDef(def: TerrainDef, sizeX: number, sizeZ: number): Terrain {
    const vertices = def.resolution + 1;
    const heights = def.heights
      ? Float32Array.from(def.heights)
      : generateHeights(vertices, {
          seed: def.seed ?? 1,
          featureSize: def.featureSize ?? DEFAULT_FEATURE_SIZE,
          octaves: def.octaves ?? DEFAULT_OCTAVES,
        });
    return new Terrain(def.resolution, def.maxHeight, sizeX, sizeZ, heights);
  }

  /** Perfectly flat ground. Useful as a null object in tests. */
  static flat(resolution: number, sizeX: number, sizeZ: number): Terrain {
    const vertices = resolution + 1;
    return new Terrain(resolution, 0, sizeX, sizeZ, new Float32Array(vertices * vertices));
  }

  /** Height in metres at a grid vertex. */
  heightAtVertex(ix: number, iz: number): number {
    const i = clampIndex(ix, this.vertices);
    const j = clampIndex(iz, this.vertices);
    return this.heights[i * this.vertices + j]! * this.maxHeight;
  }

  /**
   * Ground height in metres at a world-space point, bilinearly interpolated.
   * Points outside the arena clamp to the edge rather than falling away.
   */
  heightAt(x: number, z: number): number {
    const gx = ((x + this.sizeX / 2) / this.sizeX) * this.resolution;
    const gz = ((z + this.sizeZ / 2) / this.sizeZ) * this.resolution;

    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;

    const h00 = this.heightAtVertex(ix, iz);
    const h10 = this.heightAtVertex(ix + 1, iz);
    const h01 = this.heightAtVertex(ix, iz + 1);
    const h11 = this.heightAtVertex(ix + 1, iz + 1);

    return (
      h00 * (1 - fx) * (1 - fz) +
      h10 * fx * (1 - fz) +
      h01 * (1 - fx) * fz +
      h11 * fx * fz
    );
  }

  /** Highest point anywhere on the terrain, metres. */
  peak(): number {
    let max = 0;
    for (const h of this.heights) if (h > max) max = h;
    return max * this.maxHeight;
  }

  /** Round-trippable definition, with the heights baked in. */
  toDef(): TerrainDef {
    return {
      resolution: this.resolution,
      maxHeight: this.maxHeight,
      heights: Array.from(this.heights, (h) => Number(h.toFixed(4))),
    };
  }
}

export interface NoiseOptions {
  seed: number;
  featureSize: number;
  octaves: number;
}

/**
 * Seeded value noise, summed over octaves and normalised to 0..1.
 *
 * Value noise rather than gradient noise: it is a handful of lines, it is
 * exactly reproducible from a seed, and at this scale the difference is not
 * visible under a city.
 */
export function generateHeights(vertices: number, options: NoiseOptions): Float32Array {
  const out = new Float32Array(vertices * vertices);
  const rng = new Rng(options.seed);
  let amplitude = 1;
  let total = 0;

  for (let octave = 0; octave < options.octaves; octave++) {
    const cells = Math.max(1, Math.round((vertices - 1) / (options.featureSize / 2 ** octave)));
    const lattice = makeLattice(rng, cells + 1);

    for (let ix = 0; ix < vertices; ix++) {
      for (let iz = 0; iz < vertices; iz++) {
        const u = (ix / (vertices - 1)) * cells;
        const v = (iz / (vertices - 1)) * cells;
        out[ix * vertices + iz]! += amplitude * sampleLattice(lattice, cells + 1, u, v);
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }

  // Normalise to 0..1 so `maxHeight` means what it says.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const v = out[i]! / total;
    out[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  for (let i = 0; i < out.length; i++) {
    // Clamped, not just divided: float32 rounding can otherwise leave a value a
    // few ulps outside 0..1, which the loader and Rapier both take at face value.
    const normalised = span > 1e-9 ? (out[i]! - min) / span : 0;
    out[i] = normalised < 0 ? 0 : normalised > 1 ? 1 : normalised;
  }
  return out;
}

function makeLattice(rng: Rng, size: number): Float32Array {
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
  return lattice;
}

/** Bilinear sample with a smoothstep fade, which hides the lattice grid. */
function sampleLattice(lattice: Float32Array, size: number, u: number, v: number): number {
  const iu = Math.min(Math.floor(u), size - 2);
  const iv = Math.min(Math.floor(v), size - 2);
  const fu = smoothstep(u - iu);
  const fv = smoothstep(v - iv);

  const a = lattice[iu * size + iv]!;
  const b = lattice[(iu + 1) * size + iv]!;
  const c = lattice[iu * size + iv + 1]!;
  const d = lattice[(iu + 1) * size + iv + 1]!;

  return a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * (1 - fu) * fv + d * fu * fv;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

function clampIndex(i: number, size: number): number {
  return i < 0 ? 0 : i >= size ? size - 1 : i;
}
