/**
 * Phase 4E gates: 3D Timoshenko + P-Δ.
 */
import { describe, expect, it } from 'vitest';
import { MATERIALS, sectionProps } from '../materials';
import {
  NO_RELEASES,
  analyzeStaticModel3d,
  solveSecondOrderStatic3d,
  type EditorModel3d,
} from '../space';

function stubbyCantilever(L = 1.5): EditorModel3d {
  // L/h = 3 → shear deflection is significant.
  return {
    v: 2,
    name: 'stubby cantilever',
    seed: 0,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: L, y: 0, z: 0 },
    ],
    members: [{
      id: 1,
      a: 1, b: 2,
      material: 'steel-s355',
      section: { kind: 'rect', b: 0.3, h: 0.5 },
      releaseA: NO_RELEASES,
      releaseB: NO_RELEASES,
      roll: 0,
    }],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [{ node: 2, fx: 0, fy: 0, fz: -1000 }] },
  };
}

describe('Phase 4E — 3D Timoshenko cantilever', () => {
  it('shear-flexible tip deflection = PL³/3EIy + PL/(G·As)', () => {
    const L = 1.5;
    const model = stubbyCantilever(L);
    const mat = MATERIALS['steel-s355'];
    const props = sectionProps(model.members[0]!.section);
    const P = 1000;
    const expected = (P * L ** 3) / (3 * mat.E * props.Iy) + (P * L) / (mat.G * props.As);

    const bending = analyzeStaticModel3d(model);
    if (bending.kind !== 'stable') throw new Error(bending.message);
    const wEuler = Math.abs(bending.result.u[6 * 1 + 2]!);

    const shear = analyzeStaticModel3d(model, { shearFlexible: true });
    if (shear.kind !== 'stable') throw new Error(shear.message);
    const wShear = Math.abs(shear.result.u[6 * 1 + 2]!);

    expect(wShear).toBeGreaterThan(wEuler);
    const rel = Math.abs(wShear - expected) / expected;
    expect(rel).toBeLessThan(1e-6);
  });
});

describe('Phase 4E — 3D P-Δ amplification', () => {
  it('moment amplification approaches 1/(1 − P/Pcr) within 2%', () => {
    // Beam-column along +X: axial compression P at free tip, transverse H at tip.
    // Iy is the bending-plane inertia (about local y, load in local z direction).
    const L = 4;
    const b = 0.1, h = 0.2;
    const section = { kind: 'rect' as const, b, h };
    const mat = MATERIALS['steel-s355'];
    const props = sectionProps(section);
    // Bending about y from a −Z tip load (Iy governs plane xz). Guard the loaded
    // plane by using min(Iy, Iz).
    const Ib = Math.min(props.Iy, props.Iz);
    const Pcr = (Math.PI * Math.PI * mat.E * Ib) / (4 * L * L); // fixed-free effective length 2L
    const P = 0.25 * Pcr;
    const H = 1_000;
    const mu = L * Math.sqrt(P / (mat.E * Ib));
    const exact = Math.tan(mu) / mu;

    const model: EditorModel3d = {
      v: 2,
      name: 'beam-column',
      seed: 0,
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: L, y: 0, z: 0 },
      ],
      members: [{
        id: 1, a: 1, b: 2,
        material: 'steel-s355', section,
        releaseA: NO_RELEASES, releaseB: NO_RELEASES,
        roll: 0,
      }],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: {
        gravity: false,
        points: [{ node: 2, fx: -P, fy: 0, fz: -H }],
      },
    };

    const analysis = solveSecondOrderStatic3d(model);
    if (analysis.kind !== 'stable') throw new Error(analysis.message);
    // Compare against exact tan(μ)/μ within 2 % (matches 2D G15 tolerance).
    expect(Math.abs(analysis.momentAmplification - exact) / exact).toBeLessThan(0.02);
    expect(analysis.iterations).toBeGreaterThan(0);
    expect(analysis.momentAmplification).toBeGreaterThan(1.05);
  });

  it('recovers the linear solution when axial load is zero', () => {
    const L = 4;
    const model: EditorModel3d = {
      v: 2, name: 'linear check', seed: 0,
      nodes: [{ id: 1, x: 0, y: 0, z: 0 }, { id: 2, x: L, y: 0, z: 0 }],
      members: [{
        id: 1, a: 1, b: 2, material: 'steel-s355',
        section: { kind: 'rect', b: 0.1, h: 0.2 },
        releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0,
      }],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [{ node: 2, fx: 0, fy: 0, fz: -1000 }] },
    };
    const analysis = solveSecondOrderStatic3d(model);
    if (analysis.kind !== 'stable') throw new Error(analysis.message);
    expect(Math.abs(analysis.momentAmplification - 1)).toBeLessThan(1e-3);
  });
});
