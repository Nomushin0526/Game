/**
 * Navigation voxels: the arena chopped into 4 m cells, each free or blocked.
 *
 * Built by rasterising the map's solids and terrain analytically rather than by
 * asking Rapier hundreds of thousands of times — a 400x150x400 m arena is about
 * 380,000 cells, and the whole point is that this is cheap enough to do once at
 * match start and then query for free during the round.
 *
 * Blocking is deliberately conservative: obstacles are inflated by `clearance`
 * and rotated boxes use their axis-aligned bounds, so a path through free cells
 * always has room for a craft, even though some flyable gaps get written off.
 */

import type { MapData, Solid } from '../../maps/types.ts';
import { solidExtentY, solidHalfXZ } from '../../maps/types.ts';
import type { Vec3 } from '../../sim/types.ts';

export interface VoxelGridOptions {
  cellSize: number;
  /** Metres of space kept around every obstacle. */
  clearance: number;
}

export interface Cell {
  ix: number;
  iy: number;
  iz: number;
}

export class VoxelGrid {
  readonly cellSize: number;
  readonly dimX: number;
  readonly dimY: number;
  readonly dimZ: number;
  /** World position of the grid's minimum corner. */
  readonly origin: Vec3;
  /**
   * Per cell: `FREE`, `GEOMETRY` or `BOUNDARY`. Indexed by `index(ix, iy, iz)`.
   *
   * Boundary is tracked apart from geometry because the invisible walls block
   * movement but are not cover — you cannot hide behind them. Counting them as
   * cover made the arena's corners score as the most sheltered spots on the
   * map, and sent the runner straight into one.
   */
  private readonly blocked: Uint8Array;
  /** Lazily computed by `coverHotspots`, then shared for the rest of the map's life. */
  private hotspots: readonly Vec3[] | null = null;

  constructor(map: MapData, options: VoxelGridOptions) {
    const { cellSize, clearance } = options;
    this.cellSize = cellSize;
    this.dimX = Math.max(1, Math.ceil(map.size.x / cellSize));
    this.dimY = Math.max(1, Math.ceil((map.ceiling - map.floor) / cellSize));
    this.dimZ = Math.max(1, Math.ceil(map.size.z / cellSize));
    this.origin = { x: -map.size.x / 2, y: map.floor, z: -map.size.z / 2 };
    this.blocked = new Uint8Array(this.dimX * this.dimY * this.dimZ);

    this.markBoundary(map, clearance);
    this.markTerrain(map, clearance);
    for (const solid of map.solids) this.markSolid(solid, clearance);
  }

  get cellCount(): number {
    return this.blocked.length;
  }

  /** Flat index. Callers must have checked the coordinates are in range. */
  index(ix: number, iy: number, iz: number): number {
    return (ix * this.dimY + iy) * this.dimZ + iz;
  }

  inBounds(ix: number, iy: number, iz: number): boolean {
    return (
      ix >= 0 && ix < this.dimX &&
      iy >= 0 && iy < this.dimY &&
      iz >= 0 && iz < this.dimZ
    );
  }

  isFree(ix: number, iy: number, iz: number): boolean {
    return this.inBounds(ix, iy, iz) && this.blocked[this.index(ix, iy, iz)] === FREE;
  }

  isFreeIndex(index: number): boolean {
    return this.blocked[index] === FREE;
  }

  /** True when real geometry fills this cell, as opposed to an invisible wall. */
  isGeometry(ix: number, iy: number, iz: number): boolean {
    return this.inBounds(ix, iy, iz) && this.blocked[this.index(ix, iy, iz)] === GEOMETRY;
  }

  isFreeAt(pos: Vec3): boolean {
    const cell = this.toCell(pos);
    return this.isFree(cell.ix, cell.iy, cell.iz);
  }

  /** Cell containing a world position. May be out of bounds. */
  toCell(pos: Vec3): Cell {
    return {
      ix: Math.floor((pos.x - this.origin.x) / this.cellSize),
      iy: Math.floor((pos.y - this.origin.y) / this.cellSize),
      iz: Math.floor((pos.z - this.origin.z) / this.cellSize),
    };
  }

  /** World position of a cell's centre. */
  toWorld(ix: number, iy: number, iz: number): Vec3 {
    return {
      x: this.origin.x + (ix + 0.5) * this.cellSize,
      y: this.origin.y + (iy + 0.5) * this.cellSize,
      z: this.origin.z + (iz + 0.5) * this.cellSize,
    };
  }

  worldOfIndex(index: number): Vec3 {
    const iz = index % this.dimZ;
    const rest = (index - iz) / this.dimZ;
    const iy = rest % this.dimY;
    const ix = (rest - iy) / this.dimY;
    return this.toWorld(ix, iy, iz);
  }

  cellOfIndex(index: number): Cell {
    const iz = index % this.dimZ;
    const rest = (index - iz) / this.dimZ;
    const iy = rest % this.dimY;
    const ix = (rest - iy) / this.dimY;
    return { ix, iy, iz };
  }

  /**
   * Nearest free cell to a position, searched outwards in shells.
   * Used when a craft has ended up inside an inflated obstacle, which happens
   * routinely because the inflation is larger than the craft.
   */
  nearestFree(pos: Vec3, maxRings = 6): Cell | null {
    const start = this.toCell(pos);
    if (this.isFree(start.ix, start.iy, start.iz)) return start;

    for (let ring = 1; ring <= maxRings; ring++) {
      let best: Cell | null = null;
      let bestDistance = Infinity;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dz = -ring; dz <= ring; dz++) {
            // Only the shell, not the solid block we already searched.
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const ix = start.ix + dx;
            const iy = start.iy + dy;
            const iz = start.iz + dz;
            if (!this.isFree(ix, iy, iz)) continue;

            const centre = this.toWorld(ix, iy, iz);
            const distance = (centre.x - pos.x) ** 2 + (centre.y - pos.y) ** 2 + (centre.z - pos.z) ** 2;
            if (distance < bestDistance) {
              bestDistance = distance;
              best = { ix, iy, iz };
            }
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * True when a straight line between two points stays in free space.
   *
   * Sampled at half a cell, which cannot skip a cell. This is what makes
   * "just fly straight at it" the common case and pathfinding the exception.
   */
  lineIsFree(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(distance / (this.cellSize * 0.5)));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isFreeAt({ x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t })) {
        return false;
      }
    }
    return true;
  }

  /**
   * Fraction of nearby cells that are blocked, 0..1.
   *
   * A cheap "how much cover is here" signal: the runner uses it to head for the
   * city instead of the open sky, where being 20% slower than the hunter is a
   * death sentence. Sampled on a stride because the exact number does not
   * matter, only which of two places is denser.
   */
  coverDensity(pos: Vec3, radius = 16): number {
    const centre = this.toCell(pos);
    const reach = Math.max(1, Math.round(radius / this.cellSize));
    const stride = reach > 3 ? 2 : 1;

    let geometry = 0;
    let total = 0;
    for (let dx = -reach; dx <= reach; dx += stride) {
      for (let dy = -reach; dy <= reach; dy += stride) {
        for (let dz = -reach; dz <= reach; dz += stride) {
          const ix = centre.ix + dx;
          const iy = centre.iy + dy;
          const iz = centre.iz + dz;
          // Cells outside the arena are neither cover nor open space, so they
          // must not count either way: including them would make the edges of
          // the map read as sheltered.
          if (!this.inBounds(ix, iy, iz)) continue;
          total++;
          if (this.blocked[this.index(ix, iy, iz)] === GEOMETRY) geometry++;
        }
      }
    }
    return total > 0 ? geometry / total : 0;
  }

  /**
   * Free positions across the whole arena with the most geometry around them,
   * best first.
   *
   * Local sampling cannot help a craft that is out over the open rim of the
   * map: there is nothing within 90 m to hide behind, and the answer is to fly
   * the 150 m to the tower core. This is that answer, precomputed once and
   * shared by every AI on the map.
   */
  coverHotspots(count = 40): readonly Vec3[] {
    if (this.hotspots) return this.hotspots;

    const step = Math.max(2, Math.round(24 / this.cellSize));
    const scored: Array<{ pos: Vec3; density: number }> = [];
    for (let ix = step; ix < this.dimX - step; ix += step) {
      for (let iy = 1; iy < this.dimY - 2; iy += step) {
        for (let iz = step; iz < this.dimZ - step; iz += step) {
          if (!this.isFree(ix, iy, iz)) continue;
          const pos = this.toWorld(ix, iy, iz);
          const density = this.coverDensity(pos, this.cellSize * 5);
          if (density > 0.08) scored.push({ pos, density });
        }
      }
    }
    scored.sort((a, b) => b.density - a.density);
    this.hotspots = scored.slice(0, count).map((entry) => entry.pos);
    return this.hotspots;
  }

  /** Fraction of cells that are free. Diagnostics for the batch tool. */
  freeFraction(): number {
    let free = 0;
    for (const value of this.blocked) if (value === 0) free++;
    return free / this.blocked.length;
  }

  private markSolid(solid: Solid, clearance: number): void {
    const half = solidHalfXZ(solid);
    const [bottom, top] = solidExtentY(solid);
    this.fillBox(
      solid.pos.x - half.x - clearance,
      bottom - clearance,
      solid.pos.z - half.z - clearance,
      solid.pos.x + half.x + clearance,
      top + clearance,
      solid.pos.z + half.z + clearance,
      GEOMETRY,
    );
  }

  /** Everything at or under the ground surface, column by column. */
  private markTerrain(map: MapData, clearance: number): void {
    const terrain = map.terrain;
    if (!terrain) {
      // Flat floor: block the bottom band.
      this.fillBox(-Infinity, -Infinity, -Infinity, Infinity, map.floor + clearance, Infinity, GEOMETRY);
      return;
    }

    for (let ix = 0; ix < this.dimX; ix++) {
      for (let iz = 0; iz < this.dimZ; iz++) {
        const centre = this.toWorld(ix, 0, iz);
        const halfCell = this.cellSize / 2;
        // Highest ground anywhere under the cell footprint, so a column is
        // never declared free over the low side of a slope.
        let peak = -Infinity;
        for (const ox of [-halfCell, 0, halfCell]) {
          for (const oz of [-halfCell, 0, halfCell]) {
            peak = Math.max(peak, terrain.heightAt(centre.x + ox, centre.z + oz));
          }
        }

        const ceilingY = map.floor + peak + clearance;
        for (let iy = 0; iy < this.dimY; iy++) {
          // Block the cell if any part of it is inside the inflated ground.
          if (this.origin.y + iy * this.cellSize < ceilingY) {
            this.blocked[this.index(ix, iy, iz)] = GEOMETRY;
          } else {
            break;
          }
        }
      }
    }
  }

  /** The invisible walls and ceiling, inflated the same way solids are. */
  private markBoundary(map: MapData, clearance: number): void {
    const halfX = map.size.x / 2;
    const halfZ = map.size.z / 2;
    this.fillBox(-Infinity, -Infinity, -Infinity, -halfX + clearance, Infinity, Infinity, BOUNDARY);
    this.fillBox(halfX - clearance, -Infinity, -Infinity, Infinity, Infinity, Infinity, BOUNDARY);
    this.fillBox(-Infinity, -Infinity, -Infinity, Infinity, Infinity, -halfZ + clearance, BOUNDARY);
    this.fillBox(-Infinity, -Infinity, halfZ - clearance, Infinity, Infinity, Infinity, BOUNDARY);
    this.fillBox(-Infinity, map.ceiling - clearance, -Infinity, Infinity, Infinity, Infinity, BOUNDARY);
  }

  /**
   * Mark every cell overlapping a world-space box. Bounds may be infinite.
   *
   * Cell `i` spans `[i*c, (i+1)*c)`, so it overlaps `[min, max]` exactly when
   * `i >= floor(min/c)` and `i <= ceil(max/c) - 1`. Rounding the upper bound up
   * instead would add a whole spurious cell of padding on every face, which on
   * top of `clearance` was enough to write off entire streets.
   */
  private fillBox(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    kind: number,
  ): void {
    const loX = this.lowCell(minX - this.origin.x, this.dimX);
    const loY = this.lowCell(minY - this.origin.y, this.dimY);
    const loZ = this.lowCell(minZ - this.origin.z, this.dimZ);
    const hiX = this.highCell(maxX - this.origin.x, this.dimX);
    const hiY = this.highCell(maxY - this.origin.y, this.dimY);
    const hiZ = this.highCell(maxZ - this.origin.z, this.dimZ);

    for (let ix = loX; ix <= hiX; ix++) {
      for (let iy = loY; iy <= hiY; iy++) {
        const base = (ix * this.dimY + iy) * this.dimZ;
        for (let iz = loZ; iz <= hiZ; iz++) this.blocked[base + iz] = kind;
      }
    }
  }

  private lowCell(offset: number, size: number): number {
    if (!Number.isFinite(offset)) return offset < 0 ? 0 : size - 1;
    return clampIndex(Math.floor(offset / this.cellSize), size);
  }

  private highCell(offset: number, size: number): number {
    if (!Number.isFinite(offset)) return offset < 0 ? 0 : size - 1;
    return clampIndex(Math.ceil(offset / this.cellSize) - 1, size);
  }
}

const FREE = 0;
/** A solid or the ground: blocks movement and blocks sight. */
const GEOMETRY = 1;
/** An invisible wall or the ceiling: blocks movement, but is not cover. */
const BOUNDARY = 2;

const clampIndex = (i: number, size: number): number => (i < 0 ? 0 : i > size - 1 ? size - 1 : i);
