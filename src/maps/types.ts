/**
 * Map data format. Pure data: no physics and no rendering types, so both the
 * head-less simulation and the Three.js scene can read the same file.
 */

import type { Vec3 } from '../sim/types.ts';

/** What a solid is for. Only used for colouring and for AI heuristics. */
export type SolidTag = 'ground' | 'building' | 'bridge' | 'floater' | 'terrain' | 'prop';

export interface BoxSolid {
  shape: 'box';
  /** Centre of the box. */
  pos: Vec3;
  /** Full extents (not half-extents). */
  size: Vec3;
  /** Rotation about the Y axis, radians. Defaults to 0. */
  rotY?: number;
  tag?: SolidTag;
}

export interface CylinderSolid {
  shape: 'cylinder';
  /** Centre of the cylinder. */
  pos: Vec3;
  radius: number;
  /** Full height. */
  height: number;
  tag?: SolidTag;
}

export type Solid = BoxSolid | CylinderSolid;

export interface MapData {
  id: string;
  name: string;
  /** Playfield extents, centred on the origin. */
  size: { x: number; z: number };
  /** Invisible ceiling height. */
  ceiling: number;
  /** Ground plane height. */
  floor: number;
  /** Candidate spawn positions. `rules.ts` picks a well-separated pair. */
  spawns: Vec3[];
  solids: Solid[];
}

export function halfExtents(box: BoxSolid): Vec3 {
  return { x: box.size.x / 2, y: box.size.y / 2, z: box.size.z / 2 };
}
