/**
 * Custom workplane frames.
 */
import { describe, expect, it } from 'vitest';
import {
  frameFromPointNormal,
  frameFromThreePoints,
  projectPointToFrame,
  presetFrame,
  resolveWorkplaneFrame,
} from '../workplane';
import { scaleVec, workplaneExtrudeAxis } from '../ops3d';

describe('workplane frames (Phase 3 closeout 3T)', () => {
  it('preset frames match legacy extrude axes', () => {
    for (const kind of ['ground', 'xz', 'yz'] as const) {
      const frame = presetFrame(kind);
      const axis = workplaneExtrudeAxis(kind);
      expect(frame.n.x).toBeCloseTo(axis.x, 12);
      expect(frame.n.y).toBeCloseTo(axis.y, 12);
      expect(frame.n.z).toBeCloseTo(axis.z, 12);
    }
  });

  it('projects onto a tilted custom plane', () => {
    const frame = frameFromThreePoints(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 1 },
    );
    expect(frame).toBeDefined();
    if (!frame) return;
    const p = projectPointToFrame({ x: 0.5, y: 0.5, z: 10 }, frame);
    const relZ =
      (p.x - frame.origin.x) * frame.n.x +
      (p.y - frame.origin.y) * frame.n.y +
      (p.z - frame.origin.z) * frame.n.z;
    expect(Math.abs(relZ)).toBeLessThan(1e-12);
  });

  it('point-normal builds a right-handed triad', () => {
    const frame = frameFromPointNormal({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 });
    expect(frame).toBeDefined();
    if (!frame) return;
    expect(frame.n.z).toBeCloseTo(1, 12);
    const c = frame.u.x * frame.v.x + frame.u.y * frame.v.y + frame.u.z * frame.v.z;
    expect(Math.abs(c)).toBeLessThan(1e-12);
  });

  it('resolveWorkplaneFrame keeps custom frames intact', () => {
    const custom = frameFromThreePoints(
      { x: 0, y: 0, z: 1 },
      { x: 2, y: 0, z: 1 },
      { x: 0, y: 2, z: 1 },
    )!;
    const resolved = resolveWorkplaneFrame({ kind: 'custom', frame: custom });
    expect(resolved.origin.z).toBe(1);
    expect(resolved.n.z).toBeCloseTo(1, 12);
    expect(scaleVec(resolved.n, 5).z).toBeCloseTo(5, 12);
  });
});
