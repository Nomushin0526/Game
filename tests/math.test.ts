import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  clampLength,
  dot,
  forwardVector,
  length,
  lookAngles,
  normalize,
  rightVector,
  wrapAngle,
} from '../src/sim/math.ts';

const closeTo = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('math', () => {
  it('uses the -Z forward convention at zero yaw and pitch', () => {
    const f = forwardVector(0, 0);
    closeTo(f.x, 0);
    closeTo(f.y, 0);
    closeTo(f.z, -1);
  });

  it('turns towards -X for positive yaw', () => {
    const f = forwardVector(Math.PI / 2, 0);
    closeTo(f.x, -1);
    closeTo(f.z, 0);
  });

  it('looks up for positive pitch', () => {
    closeTo(forwardVector(0, Math.PI / 2).y, 1);
  });

  it('keeps forward and right orthonormal at any yaw', () => {
    for (const yaw of [0, 0.7, 2.2, -1.9, 3.1]) {
      const f = forwardVector(yaw, 0.4);
      const r = rightVector(yaw);
      closeTo(length(f), 1);
      closeTo(length(r), 1);
      closeTo(dot(f, r), 0);
    }
  });

  it('round-trips lookAngles through forwardVector', () => {
    const from = { x: 3, y: 10, z: -7 };
    const to = { x: -20, y: 40, z: 15 };
    const { yaw, pitch } = lookAngles(from, to);
    const f = forwardVector(yaw, pitch);
    const expected = normalize({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z });
    closeTo(f.x, expected.x);
    closeTo(f.y, expected.y);
    closeTo(f.z, expected.z);
  });

  it('wraps angles into (-PI, PI]', () => {
    closeTo(wrapAngle(Math.PI * 3), Math.PI);
    closeTo(wrapAngle(-Math.PI * 3), Math.PI);
    closeTo(wrapAngle(0.5), 0.5);
    closeTo(angleDelta(Math.PI - 0.1, -Math.PI + 0.1), 0.2);
  });

  it('clamps vector length without changing direction', () => {
    const clamped = clampLength({ x: 3, y: 0, z: 4 }, 1);
    closeTo(length(clamped), 1);
    closeTo(clamped.x, 0.6);
    closeTo(clamped.z, 0.8);
    // Already-short vectors are left alone.
    expect(clampLength({ x: 0.1, y: 0, z: 0 }, 1)).toEqual({ x: 0.1, y: 0, z: 0 });
  });

  it('returns a zero vector when normalising zero', () => {
    expect(normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
});
