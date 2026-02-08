import { describe, expect, it } from 'vitest';
import { slenderMastDemo, spacePortalDemo } from '../../presets/scenes3d';
import {
  detectResonance3d,
  measuredDaf3d,
  modalCoordinates3d,
  prepareWind3d,
  windDirectionUnit,
  windIncrementUnit3d,
  windReferenceCoordinates3d,
} from '../wind3d';
import { modal3d } from '../../fem/space/eigen';
import type { EigenResult } from '../../fem/types';

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
    const nodeCount = scenario!.mesh.ndof / 6;
    for (let node = 0; node < nodeCount; node++) {
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
    const nodeCount = scenario.mesh.ndof / 6;
    for (let node = 0; node < nodeCount; node++) {
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

describe('Phase 4C — 3D wind DAF + resonance helpers', () => {
  it('modalCoordinates3d recovers a unit projection on a mass-normalized shape', () => {
    const scenario = prepareWind3d(slenderMastDemo())!;
    const modes = modal3d(scenario.mesh, 3);
    // Feed φ₀ itself: q₀ = φ₀ᵀ M φ₀ = 1 (mass-normalized).
    const modeCount = modes.values.length;
    const phi0 = new Float64Array(scenario.mesh.ndof);
    for (let dof = 0; dof < scenario.mesh.ndof; dof++) phi0[dof] = modes.vectors[dof * modeCount]!;
    const q = modalCoordinates3d(scenario.mesh, modes, phi0, scenario.mass);
    expect(q[0]!).toBeCloseTo(1, 6);
    for (let mode = 1; mode < modeCount; mode++) expect(Math.abs(q[mode]!)).toBeLessThan(1e-6);
  });

  it('windReferenceCoordinates3d gives a nonzero reference along the excited direction', () => {
    const scenario = prepareWind3d(slenderMastDemo())!;
    const modes = modal3d(scenario.mesh, 3);
    const ref = windReferenceCoordinates3d(scenario, modes);
    let maxAbs = 0;
    for (const value of ref) maxAbs = Math.max(maxAbs, Math.abs(value));
    expect(maxAbs).toBeGreaterThan(0);
  });

  it('measuredDaf3d matches the classic 1/(2ζ) at resonance for synthetic coords', () => {
    const zeta = 0.02;
    const reference = Float64Array.of(0, 0.1, 0.05);
    // Amplitude on mode 1 driven to 1/(2ζ) × ref, others quiet.
    const coordinates = Float64Array.of(0, reference[1]! / (2 * zeta), 0);
    const daf = measuredDaf3d(coordinates, reference);
    expect(daf).toBeDefined();
    expect(daf!.mode).toBe(1);
    expect(daf!.ratio).toBeCloseTo(1 / (2 * zeta), 6);
  });

  it('G31: detectResonance3d fires only inside the ±10 % / 1.5× / ζ<5 % window', () => {
    const modal: EigenResult = {
      kind: 'modal',
      values: new Float64Array([Math.PI * 2]),
      vectors: new Float64Array(),
      iterations: 0,
    };
    // Same forcing, quiet history — no growth → no fire.
    expect(detectResonance3d(1, modal, 0.02, [1, 1, 1, 1, 1, 1, 1, 1, 2], 2)).toBeUndefined();
    // Growth exceeds 1.5× over five cycles → fires.
    expect(detectResonance3d(1, modal, 0.02, [1, 1, 1, 1, 1, 1, 1, 1, 2, 2], 2)).toBe(0);
    // ζ ≥ 5 % suppresses.
    expect(detectResonance3d(1, modal, 0.06, [1, 1, 1, 1, 1, 1, 1, 1, 2, 2], 2)).toBeUndefined();
    // Forcing outside the ±10 % frequency window suppresses resonance even with growth.
    expect(detectResonance3d(1.5, modal, 0.02, [1, 1, 1, 1, 1, 1, 1, 1, 2, 2], 2)).toBeUndefined();
  });
});
