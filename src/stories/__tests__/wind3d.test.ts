import { describe, expect, it } from 'vitest';
import { slenderMastDemo, spacePortalDemo } from '../../presets/scenes3d';
import {
  prepareWind3d,
  windDirectionUnit,
  windIncrementUnit3d,
} from '../wind3d';

describe('3D wind story (Phase 3)', () => {
  it('maps directionDeg to a horizontal unit vector', () => {
    expect(windDirectionUnit(0)).toEqual({ x: 1, y: 0, z: 0 });
    const y = windDirectionUnit(90);
    expect(y.x).toBeCloseTo(0, 12);
    expect(y.y).toBeCloseTo(1, 12);
    expect(y.z).toBe(0);
  });

  it('applies unit wind force along +X for direction 0 on a vertical mast', () => {
    const scenario = prepareWind3d(slenderMastDemo());
    expect(scenario).toBeDefined();
    const F = windIncrementUnit3d(scenario!);
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let node = 0; scenario!.mesh.ndof > node * 6; node++) {
      fx += F[6 * node]!;
      fy += F[6 * node + 1]!;
      fz += F[6 * node + 2]!;
    }
    expect(Math.abs(fx)).toBeGreaterThan(1);
    expect(Math.abs(fy)).toBeLessThan(1e-9);
    expect(Math.abs(fz)).toBeLessThan(1e-9);
  });

  it('rotates the resultant 90° when the dial points +Y', () => {
    const model = {
      ...slenderMastDemo(),
      story: { ...slenderMastDemo().story!, directionDeg: 90 },
    };
    const scenario = prepareWind3d(model)!;
    const F = windIncrementUnit3d(scenario);
    let fx = 0;
    let fy = 0;
    for (let node = 0; scenario.mesh.ndof > node * 6; node++) {
      fx += F[6 * node]!;
      fy += F[6 * node + 1]!;
    }
    expect(Math.abs(fx)).toBeLessThan(1e-9);
    expect(Math.abs(fy)).toBeGreaterThan(1);
  });

  it('prepares a Newmark-ready scenario for the space portal demo', () => {
    const scenario = prepareWind3d(spacePortalDemo());
    expect(scenario).toBeDefined();
    expect(scenario!.mesh.ndof).toBeGreaterThan(0);
    expect(scenario!.model.directionDeg).toBe(90);
    expect(scenario!.baseAnalysis.kind).toBe('stable');
  });
});
