/**
 * Map data format. Pure data: no physics and no rendering types, so both the
 * head-less simulation and the Three.js scene can read the same file.
 */

import type { Vec3 } from '../sim/types.ts';
import type { Terrain } from './terrain.ts';

/** What a solid is for. Drives colouring, and later AI cover heuristics. */
export type SolidTag =
  | 'ground'
  | 'building'
  | 'bridge'
  | 'floater'
  | 'terrain'
  | 'tunnel'
  | 'tree'
  | 'crane'
  | 'prop';

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

/**
 * A covered passage: two walls and a roof with clear air between them.
 *
 * Authored as one feature because writing three aligned boxes by hand is
 * error-prone, but expanded to plain solids at load time so physics and
 * rendering never need to know tunnels exist.
 */
export interface TunnelDef {
  /** Centre of the passage, at the middle of its clear interior. */
  pos: Vec3;
  /** Length along the passage axis. */
  length: number;
  /** Clear interior width. */
  width: number;
  /** Clear interior height. */
  height: number;
  /** Wall and roof thickness. Defaults to 3 m. */
  thickness?: number;
  /** Rotation about Y. 0 runs the passage along Z. */
  rotY?: number;
  /** Add a floor slab under the passage. Defaults to false (terrain is below). */
  floor?: boolean;
}

export interface MapData {
  id: string;
  name: string;
  /** Playfield extents, centred on the origin. */
  size: { x: number; z: number };
  /** Invisible ceiling height. */
  ceiling: number;
  /** Base ground height. Terrain relief rises from here. */
  floor: number;
  /** Ground relief, or undefined for a flat floor. */
  terrain?: Terrain;
  /** Candidate spawn positions. `World` picks a well-separated pair. */
  spawns: Vec3[];
  solids: Solid[];
}

/** Vertical extent of a solid, as [bottom, top] in metres. */
export function solidExtentY(solid: Solid): [number, number] {
  const half = solid.shape === 'box' ? solid.size.y / 2 : solid.height / 2;
  return [solid.pos.y - half, solid.pos.y + half];
}

/** Horizontal half-size of a solid, ignoring rotation. Conservative. */
export function solidHalfXZ(solid: Solid): { x: number; z: number } {
  if (solid.shape === 'cylinder') return { x: solid.radius, z: solid.radius };
  const rotY = solid.rotY ?? 0;
  if (rotY === 0) return { x: solid.size.x / 2, z: solid.size.z / 2 };
  // Bounding box of the rotated footprint.
  const c = Math.abs(Math.cos(rotY));
  const s = Math.abs(Math.sin(rotY));
  return {
    x: (solid.size.x * c + solid.size.z * s) / 2,
    z: (solid.size.x * s + solid.size.z * c) / 2,
  };
}

/**
 * Expand a tunnel into the walls and roof that actually collide.
 * With `rotY = 0` the passage runs along Z, so the walls sit on either side in X.
 */
export function tunnelSolids(tunnel: TunnelDef): Solid[] {
  const thickness = tunnel.thickness ?? 3;
  const rotY = tunnel.rotY ?? 0;
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  // Local +X offset rotated into world space; local +Z is the passage axis.
  const offsetX = (d: number): Vec3 => ({ x: tunnel.pos.x + d * cos, y: tunnel.pos.y, z: tunnel.pos.z - d * sin });

  const wallOffset = (tunnel.width + thickness) / 2;
  const solids: Solid[] = [
    {
      shape: 'box',
      pos: offsetX(-wallOffset),
      size: { x: thickness, y: tunnel.height, z: tunnel.length },
      rotY,
      tag: 'tunnel',
    },
    {
      shape: 'box',
      pos: offsetX(wallOffset),
      size: { x: thickness, y: tunnel.height, z: tunnel.length },
      rotY,
      tag: 'tunnel',
    },
    {
      shape: 'box',
      pos: { x: tunnel.pos.x, y: tunnel.pos.y + (tunnel.height + thickness) / 2, z: tunnel.pos.z },
      size: { x: tunnel.width + thickness * 2, y: thickness, z: tunnel.length },
      rotY,
      tag: 'tunnel',
    },
  ];

  if (tunnel.floor) {
    solids.push({
      shape: 'box',
      pos: { x: tunnel.pos.x, y: tunnel.pos.y - (tunnel.height + thickness) / 2, z: tunnel.pos.z },
      size: { x: tunnel.width + thickness * 2, y: thickness, z: tunnel.length },
      rotY,
      tag: 'tunnel',
    });
  }
  return solids;
}
