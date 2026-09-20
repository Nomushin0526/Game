/** Small vector helpers. Kept dependency-free so `sim/` stays head-less. */

import type { Vec3 } from './types.ts';

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len) : { x: 0, y: 0, z: 0 };
}

/** Clamp a vector's magnitude to `max` without changing its direction. */
export function clampLength(a: Vec3, max: number): Vec3 {
  const len = length(a);
  return len > max && len > 1e-9 ? scale(a, max / len) : a;
}

/**
 * Yaw/pitch to a unit forward vector.
 *
 * Convention (matches Three.js): yaw 0 and pitch 0 face -Z, positive yaw turns
 * towards -X, positive pitch looks up.
 */
export function forwardVector(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Unit vector pointing to the craft's right, always level with the horizon. */
export function rightVector(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

/** Yaw/pitch that would look from `from` towards `to`. */
export function lookAngles(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const d = sub(to, from);
  const horizontal = Math.hypot(d.x, d.z);
  return {
    yaw: Math.atan2(-d.x, -d.z),
    pitch: Math.atan2(d.y, horizontal),
  };
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Shortest signed difference `to - from`, wrapped to (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * Distance along the ray to the first intersection with a sphere, or null.
 * Only hits in front of the origin and within `maxDistance` count.
 */
export function raySphere(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDistance: number,
): number | null {
  const toCenter = sub(center, origin);
  const along = dot(toCenter, dir);
  const distanceSq = dot(toCenter, toCenter) - along * along;
  const radiusSq = radius * radius;
  if (distanceSq > radiusSq) return null;

  const half = Math.sqrt(radiusSq - distanceSq);
  // Near intersection first; if we start inside the sphere, use the entry point 0.
  const near = along - half;
  const t = near >= 0 ? near : along + half >= 0 ? 0 : null;
  if (t === null || t > maxDistance) return null;
  return t;
}
