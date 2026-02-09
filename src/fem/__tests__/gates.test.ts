/**
 * The honesty gates. Tolerances are measured, not aspirational
 * (they were validated numerically before the plan was written; see §13.A).
 * Each milestone converts its `it.todo` rows into real tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleF,
  assembleK,
  assembleLoadCase,
  elementLocalStiffness,
  kLocal,
  kgLocal,
  mLocal,
  shearFactor,
  transformToGlobal,
} from '../assemble';
import { solveTensionOnly } from '../cables';
import { buckling, modal } from '../eigen';
import { newmarkStep, rayleighDampingRatio, rayleighFit, type NewmarkState } from '../dynamics';
import { decodeModel, encodeModel } from '../../share/serialize';
import { collapseCascade, evaluateFailure } from '../failure';
import { computeInfluenceLine } from '../influence';
import { MATERIALS, plasticMoment, sectionProps } from '../materials';
import {
  assembleMassWithVehicle,
  lumpedVehicleTranslationalTrace,
  vehicleMassKg,
} from '../moving-mass';
import { buildMesh } from '../mesh';
import { mulberry32 } from '../rng';
import { runPushover } from '../pushover';
import { earthquakeRecord } from '../records';
import { solveSecondOrderStatic } from '../second-order';
import { newmarkSdofRelative, peakAbs, responseSpectrum } from '../spectrum';
import {
  expandFreeVector,
  factorLDLT,
  freeMatrix,
  freeVector,
  mechanismEditorNode,
  solveFactored,
} from '../solve';
import { analyzeStaticModel, solveStatic } from '../statics';
import {
  analyzeTrafficAt,
  initialMovingMassState,
  prepareTraffic,
  vehicleContactsAt,
} from '../../stories/traffic';
import type { AnalysisMesh, EditorModel, MemberSpec, SectionSpec, SupportSpec } from '../types';

const E = 1,
  A = 1,
  I = 1,
  L = 1,
  rho = 1;

describe('element matrices (implemented — scaffold anchor)', () => {
  it('kLocal is symmetric with textbook entries', () => {
    const k = kLocal(E, A, I, L);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) expect(k[i * 6 + j]).toBeCloseTo(k[j * 6 + i]!, 12);
    expect(k[0]).toBeCloseTo((E * A) / L, 12); // EA/L
    expect(k[7]).toBeCloseTo(12, 12); // 12EI/L³
    expect(k[14]).toBeCloseTo(4, 12); // 4EI/L
    expect(k[17]).toBeCloseTo(2, 12); // 2EI/L
  });

  it('G1: cantilever tip deflection PL³/3EI and rotation PL²/2EI (bending block closed form)', () => {
    // Free DOFs of the tip node under transverse P=1: solve the 2x2 [v,θ] block.
    const k = kLocal(E, A, I, L);
    const kff = Float64Array.of(k[4 * 6 + 4]!, k[4 * 6 + 5]!, k[5 * 6 + 4]!, k[5 * 6 + 5]!);
    const factored = factorLDLT(kff, 2);
    if (!factored.ok) throw new Error('A cantilever bending block must be positive definite.');
    const [v, th] = solveFactored(factored.factor, Float64Array.of(1, 0));
    expect(v).toBeCloseTo(1 / 3, 10); // PL³/3EI
    expect(th).toBeCloseTo(1 / 2, 10); // PL²/2EI
  });

  it('kgLocal: consistent geometric stiffness entries and symmetry', () => {
    const g = kgLocal(-1, L); // unit compression
    expect(g[1 * 6 + 1]).toBeCloseTo(-6 / 5, 12);
    expect(g[2 * 6 + 2]).toBeCloseTo(-2 / 15, 12);
    expect(g[2 * 6 + 5]).toBeCloseTo(1 / 30, 12);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) expect(g[i * 6 + j]).toBeCloseTo(g[j * 6 + i]!, 12);
  });

  it('mLocal: consistent mass entries, symmetry, and total mass', () => {
    const m = mLocal(rho, A, L);
    expect(m[1 * 6 + 1]).toBeCloseTo(156 / 420, 12);
    expect(m[1 * 6 + 4]).toBeCloseTo(54 / 420, 12);
    // translational mass sums to ρAL per direction
    let sum = 0;
    for (const i of [1, 4]) for (const j of [1, 4]) sum += m[i * 6 + j]!;
    expect(sum).toBeCloseTo(rho * A * L, 12);
  });

  it('transformToGlobal preserves symmetry and eigen-invariants (trace)', () => {
    const k = kLocal(2, 3, 0.5, 1.7);
    const kg = transformToGlobal(k, Math.cos(0.7), Math.sin(0.7));
    let trLocal = 0,
      trGlobal = 0;
    for (let i = 0; i < 6; i++) {
      trLocal += k[i * 6 + i]!;
      trGlobal += kg[i * 6 + i]!;
      for (let j = 0; j < 6; j++) expect(kg[i * 6 + j]).toBeCloseTo(kg[j * 6 + i]!, 9);
    }
    expect(trGlobal).toBeCloseTo(trLocal, 9); // similarity transform preserves trace
  });

  it('G10: section properties vs hand calcs', () => {
    const r = sectionProps({ kind: 'rect', b: 0.2, h: 0.4 });
    expect(r.A).toBeCloseTo(0.08, 12);
    expect(r.I).toBeCloseTo((0.2 * 0.4 ** 3) / 12, 15);
    expect(r.As).toBeCloseTo((5 / 6) * 0.08, 12);
    const i = sectionProps({ kind: 'ibeam', b: 0.2, h: 0.4, tf: 0.02, tw: 0.01 });
    expect(i.As).toBeCloseTo(0.01 * (0.4 - 2 * 0.02), 12);
    const t = sectionProps({ kind: 'tube', d: 0.2, t: 0.01 });
    expect(t.A).toBeCloseTo((Math.PI / 4) * (0.2 ** 2 - 0.18 ** 2), 12);
    expect(t.As).toBeCloseTo(0.5 * t.A, 12);
  });
});

describe('2D support constraints', () => {
  it('G2b: a roller releases its horizontal reaction under an inclined tip load', () => {
    const nodes = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 8, y: 0 },
    ];
    const analyze = (rightSupport: SupportSpec['kind']) => {
      const model = modelFor(nodes, [
        { node: 1, kind: 'pin' },
        { node: 2, kind: rightSupport },
      ]);
      model.loads.points = [{ node: 2, fx: 20_000, fy: -10_000 }];
      const analysis = analyzeStaticModel(model);
      if (analysis.kind !== 'stable')
        throw new Error(`Expected a stable beam, received ${analysis.kind}.`);
      return analysis;
    };

    const pinned = analyze('pin');
    const roller = analyze('roller');
    expect(Math.abs(pinned.result.reactions.get(2)?.fx ?? 0)).toBeGreaterThan(1);
    expect(Math.abs(roller.result.reactions.get(2)?.fx ?? Number.POSITIVE_INFINITY)).toBeLessThan(
      1e-10,
    );
    expect(roller.mesh.freeDofs).toContain(3);
  });

  it('G2c: UDL utilization includes the exact in-span shear-zero moment', () => {
    const mesh: AnalysisMesh = {
      coords: Float64Array.of(0, 0, 8, 0),
      elements: [
        {
          memberId: 1,
          na: 0,
          nb: 1,
          E: 210e9,
          G: 80e9,
          A: 0.01,
          As: 0.008,
          I: 1e-4,
          c: 0.1,
          rho: 0,
          fy: 355e6,
          L: 8,
          cos: 1,
          sin: 0,
          releaseA: false,
          releaseB: false,
        },
      ],
      editorNode: Int32Array.of(1, 2),
      freeDofs: Int32Array.of(2, 3, 5),
      ndof: 6,
      shearFlexible: false,
    };
    const loads = assembleLoadCase(mesh, {
      gravity: false,
      points: [],
      elementUdls: [{ element: 0, w: 10_000 }],
    });
    const analysis = solveStatic(mesh, loads);
    if (analysis.kind !== 'stable')
      throw new Error(`Expected a stable beam, got ${analysis.kind}.`);

    const [N, va, ma, vb, mb] = analysis.result.elementForces;
    const v1 = -va!;
    const v2 = vb!;
    const xStar = (mesh.elements[0]!.L * v1) / (v1 - v2);
    const mStar = -ma! + v1 * xStar - (10_000 * xStar ** 2) / 2;
    const endpoint = Math.max(Math.abs(ma!), Math.abs(mb!));
    const expected = Math.abs(N! / 0.01 + (mStar * 0.1) / 1e-4) / 355e6;

    expect(xStar).toBeCloseTo(4, 12);
    expect(Math.abs(mStar)).toBeGreaterThan(endpoint * 1.1);
    expect(analysis.result.utilization.get(1)).toBeCloseTo(expected, 12);
    expect(analysis.result.utilizationStationM?.get(1)).toBeCloseTo(4, 12);
  });
});

describe('Phase 2A — Timoshenko shear-flexible beams', () => {
  it('G14: Timoshenko cantilever tip = PL³/3EI + PL/(G As), rel err < 1e-9', () => {
    // Unit properties (same harness style as G1): E=I=G=As=L=1, P=1.
    // One analysis element recovers the closed form exactly; the product mesh
    // uses two subdivisions and is checked below for consistency.
    const mesh: AnalysisMesh = {
      coords: Float64Array.of(0, 0, 1, 0),
      elements: [
        {
          memberId: 1,
          na: 0,
          nb: 1,
          L: 1,
          E: 1,
          G: 1,
          A: 1,
          As: 1,
          I: 1,
          c: 1,
          rho: 1,
          fy: 1,
          cos: 1,
          sin: 0,
          releaseA: false,
          releaseB: false,
        },
      ],
      editorNode: Int32Array.of(1, 2),
      freeDofs: Int32Array.of(3, 4, 5),
      ndof: 6,
      shearFlexible: true,
    };
    const loads = assembleF(mesh, { gravity: false, points: [{ meshNode: 1, fx: 0, fy: -1 }] });
    const result = solveMesh(mesh, loads);
    const expected = -(1 / 3 + 1); // −(PL³/3EI + PL/(G As))
    expect(relativeError(result.u[4]!, expected)).toBeLessThan(1e-9);

    // Product path (2 subdivisions, SI steel) must still beat Euler and stay close.
    const span = 2;
    const P = 10_000;
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: span, y: 0 },
      ],
      [{ node: 1, kind: 'fixed' }],
    );
    model.loads.gravity = false;
    model.loads.points = [{ node: 2, fx: 0, fy: -P }];
    model.members[0]!.section = { kind: 'rect', b: 0.4, h: 0.4 }; // L/h = 5

    const analysis = analyzeStaticModel(model, { shearFlexible: true });
    if (analysis.kind !== 'stable')
      throw new Error(`Expected stable Timoshenko cantilever, received ${analysis.kind}.`);
    const sample = analysis.mesh.elements[0]!;
    const siExpected = -((P * span ** 3) / (3 * sample.E * sample.I) + P / (sample.G * sample.As));
    expect(relativeError(analysis.result.u[3 * 1 + 1]!, siExpected)).toBeLessThan(1e-6);

    const euler = analyzeStaticModel(model, { shearFlexible: false });
    if (euler.kind !== 'stable')
      throw new Error(`Expected stable Euler cantilever, received ${euler.kind}.`);
    const bendingOnly = -((P * span ** 3) / (3 * sample.E * sample.I));
    expect(relativeError(euler.result.u[3 * 1 + 1]!, bendingOnly)).toBeLessThan(1e-10);
    expect(Math.abs(analysis.result.u[3 * 1 + 1]!)).toBeGreaterThan(
      Math.abs(euler.result.u[3 * 1 + 1]!),
    );
  });

  it('kLocal(φ) tip block recovers PL³/3EI + PL/(G As) exactly', () => {
    // Unit properties: E=I=G=As=L=1 ⇒ φ = 12, tip v = 1/3 + 1 = 4/3.
    const phi = shearFactor(1, 1, 1, 1, 1);
    expect(phi).toBeCloseTo(12, 12);
    const k = kLocal(1, 1, 1, 1, phi);
    const kff = Float64Array.of(k[4 * 6 + 4]!, k[4 * 6 + 5]!, k[5 * 6 + 4]!, k[5 * 6 + 5]!);
    const factored = factorLDLT(kff, 2);
    if (!factored.ok) throw new Error('Timoshenko tip block must be positive definite.');
    const [v] = solveFactored(factored.factor, Float64Array.of(1, 0));
    expect(v).toBeCloseTo(4 / 3, 12);
  });
});

describe('Phase 2B — P-Δ second-order statics', () => {
  it('G15: beam-column moment amplification ≈ 1/(1−P/P_cr) within 2%', () => {
    // Fixed-free cantilever: tip lateral H + axial compression P.
    // Exact small-deflection amplification of base moment is tan(μ)/μ with
    // μ = L√(P/EI); the engineering approximation is 1/(1−P/P_cr).
    const L = 10;
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 0, y: L },
      ],
      [{ node: 1, kind: 'fixed' }],
    );
    model.loads.gravity = false;
    model.members[0]!.section = { kind: 'rect', b: 0.2, h: 0.2 };
    const mesh = buildMesh(model);
    const E = mesh.elements[0]!.E;
    const I = mesh.elements[0]!.I;
    const Pcr = (Math.PI ** 2 * E * I) / (4 * L * L);
    const P = 0.25 * Pcr;
    const H = 1_000;
    const loads = assembleLoadCase(mesh, {
      gravity: false,
      points: [{ meshNode: 1, fx: H, fy: -P }],
    });
    const second = solveSecondOrderStatic(mesh, loads);
    if (second.kind !== 'stable')
      throw new Error(`Expected converged P-Δ, received ${second.kind}.`);
    const mu = L * Math.sqrt(P / (E * I));
    const exact = Math.tan(mu) / mu;
    const approximate = 1 / (1 - P / Pcr);
    expect(relativeError(second.momentAmplification, exact)).toBeLessThan(0.02);
    // The engineering approximation — keep it within a few percent of exact.
    expect(relativeError(approximate, exact)).toBeLessThan(0.05);
    expect(second.momentAmplification).toBeGreaterThan(1.05);
    expect(second.iterations).toBeLessThanOrEqual(8);
  });
});

describe('Phase 2C — earthquake spectrum', () => {
  it('G16: SDOF spectrum peak matches Newmark SDOF run within 2%', () => {
    const record = earthquakeRecord('pulse');
    const zeta = 0.05;
    const spectrum = responseSpectrum(record, zeta);
    const peak = spectrum.points[spectrum.peakIndex]!;
    const omega = 2 * Math.PI * peak.freqHz;
    const u = newmarkSdofRelative(omega, zeta, record.accel, record.dt);
    const sa = omega * omega * peakAbs(u);
    expect(relativeError(peak.sa, sa)).toBeLessThan(0.02);
    expect(peak.sa).toBeGreaterThan(0);
  });
});

describe('Phase 2D — influence lines', () => {
  it('G17: SS beam midspan-moment influence line is piecewise-linear with peak L/4 (exact)', () => {
    // Simply-supported span: η_M(mid)(x) = x/2 for x ≤ L/2 and (L−x)/2 for x ≥ L/2.
    // Peak at midspan load is L/4. Gate G17.
    const L = 8;
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: L, y: 0 },
      ],
      [
        { node: 1, kind: 'pin' },
        { node: 2, kind: 'roller' },
      ],
    );
    model.deck = [1];
    const line = computeInfluenceLine(
      model,
      { kind: 'moment', memberId: 1, at: 'mid' },
      { step: L / 40 },
    );
    expect(line.samples.length).toBeGreaterThan(10);
    expect(relativeError(line.peak.value, L / 4)).toBeLessThan(1e-12);
    expect(Math.abs(line.peak.station - L / 2)).toBeLessThan(L / 40 + 1e-12);
    for (const sample of line.samples) {
      const expected = sample.station <= L / 2 ? sample.station / 2 : (L - sample.station) / 2;
      expect(relativeError(sample.value, expected)).toBeLessThan(1e-12);
    }
    // Piecewise linearity: samples on each half lie on the analytical rays.
    const left = line.samples.filter((sample) => sample.station <= L / 2);
    const right = line.samples.filter((sample) => sample.station >= L / 2);
    expect(left.length).toBeGreaterThan(2);
    expect(right.length).toBeGreaterThan(2);
    expect(relativeError(left[0]!.value, 0)).toBeLessThan(1e-12);
    expect(relativeError(right[right.length - 1]!.value, 0)).toBeLessThan(1e-12);
  });
});

describe('Phase 2E — tension-only cables', () => {
  it('G18: guyed mast under lateral load — load-side guy slack, restraint guy taut (golden)', () => {
    // Tip +Fx: left restraint guy stays in tension, right load-side guy goes slack.
    // Gate G18.
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 0, y: 20 },
        { id: 3, x: -12, y: 0 },
        { id: 4, x: 12, y: 0 },
      ],
      [
        { node: 1, kind: 'fixed' },
        { node: 3, kind: 'pin' },
        { node: 4, kind: 'pin' },
      ],
      [
        {
          id: 1,
          a: 1,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'tube', d: 0.2, t: 0.01 },
          releaseA: false,
          releaseB: false,
          cableOnly: false,
        },
        {
          id: 2,
          a: 3,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'rect', b: 0.02, h: 0.02 },
          releaseA: true,
          releaseB: true,
          cableOnly: true,
        },
        {
          id: 3,
          a: 4,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'rect', b: 0.02, h: 0.02 },
          releaseA: true,
          releaseB: true,
          cableOnly: true,
        },
      ],
    );
    model.loads = { gravity: false, points: [{ node: 2, fx: 50_000, fy: 0 }] };
    const result = solveTensionOnly(model);
    expect(result.analysis.kind).toBe('stable');
    expect(result.frozen).toBe(false);
    expect(result.activeCables).toEqual([2]);
    expect(result.slackCables).toEqual([3]);
    if (result.analysis.kind !== 'stable') throw new Error('expected stable');
    const leftN =
      result.analysis.result.elementForces[
        result.analysis.mesh.elements.findIndex((element) => element.memberId === 2) * 5
      ]!;
    expect(leftN).toBeGreaterThan(0);
  });
});

describe('Phase 2F — plastic pushover', () => {
  it('G19: portal frame collapse load vs 4M_p/h within 3%', () => {
    // Fixed-base single bay portal, equal M_p, eaves lateral load. Gate G19.
    const h = 4;
    const section = { kind: 'rect' as const, b: 0.2, h: 0.3 };
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 8, y: 0 },
        { id: 3, x: 0, y: h },
        { id: 4, x: 8, y: h },
      ],
      [
        { node: 1, kind: 'fixed' },
        { node: 2, kind: 'fixed' },
      ],
      [
        {
          id: 1,
          a: 1,
          b: 3,
          material: 'steel-s355',
          section,
          releaseA: false,
          releaseB: false,
          cableOnly: false,
        },
        {
          id: 2,
          a: 2,
          b: 4,
          material: 'steel-s355',
          section,
          releaseA: false,
          releaseB: false,
          cableOnly: false,
        },
        {
          id: 3,
          a: 3,
          b: 4,
          material: 'steel-s355',
          section,
          releaseA: false,
          releaseB: false,
          cableOnly: false,
        },
      ],
    );
    model.loads = { gravity: false, points: [{ node: 3, fx: 1_000, fy: 0 }] };
    const Mp = plasticMoment(section, MATERIALS['steel-s355'].fy);
    const expected = (4 * Mp) / h;
    const result = runPushover(model);
    expect(result.outcome).toBe('mechanism');
    expect(result.hinges.length).toBeGreaterThanOrEqual(3);
    expect(relativeError(result.collapseBaseShear, expected)).toBeLessThan(0.03);
  });
});

describe('Phase 2H — moving-mass traffic', () => {
  it('G21: lumped vehicle mass conserved; parked Newmark settles to quasi-static midspan within 2%', () => {
    // Gate G21.
    const model: EditorModel = {
      v: 1,
      name: 'Moving-mass gate',
      seed: 21,
      nodes: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 8, y: 0 },
        { id: 3, x: 16, y: 0 },
      ],
      members: [member(1, 1, 2), member(2, 2, 3)],
      supports: [
        { node: 1, kind: 'pin' },
        { node: 3, kind: 'roller' },
      ],
      loads: { gravity: false, points: [] },
      deck: [1, 2],
      story: { kind: 'traffic', weightkN: 200, speed: 0.5, movingMass: true },
    };
    const scenario = prepareTraffic(model);
    const front = scenario.length / 2;
    const contacts = vehicleContactsAt(scenario, front);
    const totalMass = contacts.reduce((sum, contact) => sum + contact.massKg, 0);
    expect(totalMass).toBeCloseTo(vehicleMassKg(200), 9);
    expect(lumpedVehicleTranslationalTrace(contacts)).toBeCloseTo(2 * totalMass, 9);

    const staticFrame = analyzeTrafficAt(scenario, front);
    if (staticFrame.analysis.kind !== 'stable') throw new Error('expected stable static traffic');
    const midMesh = [...scenario.mesh.editorNode].findIndex((id) => id === 2);
    expect(midMesh).toBeGreaterThanOrEqual(0);
    const staticMid = Math.abs(staticFrame.analysis.result.u[3 * midMesh + 1]!);

    // Parked: hold station fixed while integrating with vehicle mass on the Rayleigh-damped system.
    let state = initialMovingMassState(scenario, front);
    const parkedLoad = staticFrame.analysis.loads.F;
    for (let i = 0; i < 400; i++) {
      const mass = assembleMassWithVehicle(scenario.mesh, vehicleContactsAt(scenario, front));
      state = newmarkStep(
        scenario.mesh,
        state,
        () => parkedLoad,
        scenario.dt,
        scenario.damping,
        mass,
      );
    }
    const dynamicMid = Math.abs(state.u[3 * midMesh + 1]!);
    expect(relativeError(dynamicMid, staticMid)).toBeLessThan(0.02);
  });
});

describe('M1 gates — statics', () => {
  it('G2: SS beam UDL midspan = 5wL⁴/384EI at mid-node, rel err < 1e-10', () => {
    const span = 8;
    const w = 12_000;
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: span, y: 0 },
      ],
      [
        { node: 1, kind: 'pin' },
        { node: 2, kind: 'roller' },
      ],
    );
    const mesh = buildMesh(model);
    const result = solveMesh(
      mesh,
      assembleF(mesh, {
        gravity: false,
        points: [],
        elementUdls: mesh.elements.map((_, element) => ({ element, w })),
      }),
    );
    const E = mesh.elements[0]!.E;
    const I = mesh.elements[0]!.I;
    const expected = (-5 * w * span ** 4) / (384 * E * I);
    const actual = result.u[3 * 2 + 1]!; // original nodes are 0/1; the hidden mid-node is 2.
    expect(relativeError(actual, expected)).toBeLessThan(1e-10);
  });

  it('G5: assembled K is symmetric and Betti reciprocity holds on seeded frames, 1e-9', () => {
    const random = mulberry32(0x1a2b3c4d);
    for (let frame = 0; frame < 5; frame++) {
      const width = 4 + 3 * random();
      const height = 2 + 3 * random();
      const mesh = buildMesh(
        modelFor(
          [
            { id: 1, x: 0, y: 0 },
            { id: 2, x: width, y: 0 },
            { id: 3, x: width / 2 + (random() - 0.5), y: height },
          ],
          [
            { node: 1, kind: 'fixed' },
            { node: 2, kind: 'fixed' },
          ],
          [member(1, 1, 3), member(2, 3, 2), member(3, 1, 2)],
        ),
      );
      const K = assembleK(mesh);
      for (let i = 0; i < mesh.ndof; i++) {
        for (let j = 0; j < mesh.ndof; j++) {
          expect(relativeError(K[i * mesh.ndof + j]!, K[j * mesh.ndof + i]!)).toBeLessThan(1e-12);
        }
      }

      const apex = mesh.editorNode.findIndex((id) => id === 3);
      const a = 3 * apex;
      const b = a + 1;
      const first = solveMesh(mesh, pointLoad(mesh.ndof, a, 1));
      const second = solveMesh(mesh, pointLoad(mesh.ndof, b, 1));
      expect(relativeError(first.u[b]!, second.u[a]!)).toBeLessThan(1e-9);
    }
  });

  it('G6: unsupported and underbraced models are flagged at the free editor node', () => {
    const unsupported = buildMesh(modelFor([{ id: 1, x: 0, y: 0 }], [], []));
    expect(mechanismNode(unsupported)).toBe(1);

    const underbraced = buildMesh(
      modelFor(
        [
          { id: 1, x: 0, y: 0 },
          { id: 2, x: 4, y: 0 },
        ],
        [{ node: 1, kind: 'pin' }],
      ),
    );
    expect(mechanismNode(underbraced)).toBe(2);
  });

  it('G7: released truss members carry |M| < 1e-8 under nodal loads', () => {
    const trussMember = (id: number, a: number, b: number): MemberSpec => ({
      ...member(id, a, b),
      releaseA: true,
      releaseB: true,
      cableOnly: false,
    });
    const mesh = buildMesh(
      modelFor(
        [
          { id: 1, x: 0, y: 0 },
          { id: 2, x: 4, y: 0 },
          { id: 3, x: 2, y: 3 },
        ],
        [
          { node: 1, kind: 'pin' },
          { node: 2, kind: 'roller' },
        ],
        [trussMember(1, 1, 2), trussMember(2, 1, 3), trussMember(3, 3, 2)],
      ),
    );
    const apex = mesh.editorNode.findIndex((id) => id === 3);
    const result = solveMesh(mesh, pointLoad(mesh.ndof, 3 * apex + 1, -100_000));

    for (const element of mesh.elements) {
      const localU = localElementDisplacement(
        result.u,
        element.na,
        element.nb,
        element.cos,
        element.sin,
      );
      const stiffness = elementLocalStiffness(element);
      const endForces = multiplyMatrixVector(stiffness, localU);
      expect(Math.abs(endForces[2]!)).toBeLessThan(1e-8);
      expect(Math.abs(endForces[5]!)).toBeLessThan(1e-8);
    }
  });

  it('G13: in-element point loads conserve reaction and are continuous at a mesh node', () => {
    const mesh = buildMesh(
      modelFor(
        [
          { id: 1, x: 0, y: 0 },
          { id: 2, x: 8, y: 0 },
        ],
        [
          { node: 1, kind: 'pin' },
          { node: 2, kind: 'roller' },
        ],
      ),
    );
    const P = 42_000;
    const interiorLoad = assembleF(mesh, {
      gravity: false,
      points: [],
      inElement: [{ element: 0, xi: 0.37, p: P }],
    });
    const interior = solveMesh(mesh, interiorLoad);
    const reactions = residual(assembleK(mesh), interior.u, interiorLoad, mesh.ndof);
    let verticalReaction = 0;
    for (let node = 0; mesh.ndof > node * 3; node++) verticalReaction += reactions[3 * node + 1]!;
    expect(relativeError(verticalReaction, P)).toBeLessThan(1e-10);

    const fromLeft = solveMesh(
      mesh,
      assembleF(mesh, {
        gravity: false,
        points: [],
        inElement: [{ element: 0, xi: 1, p: P }],
      }),
    );
    const fromRight = solveMesh(
      mesh,
      assembleF(mesh, {
        gravity: false,
        points: [],
        inElement: [{ element: 1, xi: 0, p: P }],
      }),
    );
    for (let dof = 0; dof < mesh.ndof; dof++) {
      expect(relativeError(fromLeft.u[dof]!, fromRight.u[dof]!)).toBeLessThan(1e-12);
    }
  });
});

describe('M4 gates — eigenanalysis', () => {
  it('G3: pinned column λ_cr = 9.9438 (2 elem) vs π² = 9.8696, within +0.8% (measured +0.75%)', () => {
    const result = buckling(pinnedColumnMesh(2), Float64Array.of(-1, -1));
    expect(result.kind).toBe('buckling');
    expect(result.values.length).toBeGreaterThan(0);
    expect(relativeError(result.values[0]!, Math.PI ** 2)).toBeLessThan(0.008);
  });

  it('G3b: 4 elem λ_cr within +0.1% of π² (measured +0.051%)', () => {
    const result = buckling(pinnedColumnMesh(4), Float64Array.of(-1, -1, -1, -1));
    expect(result.values.length).toBeGreaterThan(0);
    expect(relativeError(result.values[0]!, Math.PI ** 2)).toBeLessThan(0.001);
  });

  it('G4: SS beam ω₁ = 9.9086 (2 elem) vs π² rad/s, within +0.5% (measured +0.39%)', () => {
    const result = modal(simplySupportedBendingBeam(), 1);
    expect(result.kind).toBe('modal');
    expect(result.values.length).toBe(1);
    expect(relativeError(result.values[0]!, Math.PI ** 2)).toBeLessThan(0.005);
  });
});

describe('M3 static result recovery', () => {
  it('recovers displacements, reactions, and utilization from the editor load case', () => {
    const model = modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 4, y: 0 },
      ],
      [{ node: 1, kind: 'fixed' }],
    );
    model.loads.gravity = false;
    model.loads.points = [{ node: 2, fx: 0, fy: -1_000 }];
    const analysis = analyzeStaticModel(model);
    if (analysis.kind !== 'stable')
      throw new Error(`Expected a stable model, received ${analysis.kind}.`);

    const E = analysis.mesh.elements[0]!.E;
    const I = analysis.mesh.elements[0]!.I;
    const expectedTip = (-1_000 * 4 ** 3) / (3 * E * I);
    expect(relativeError(analysis.result.u[3 * 1 + 1]!, expectedTip)).toBeLessThan(1e-10);
    expect(relativeError(analysis.result.reactions.get(1)!.fy, 1_000)).toBeLessThan(1e-10);
    expect(analysis.result.utilization.get(1)).toBeGreaterThan(0);
  });
});

describe('M5 gates — dynamics', () => {
  it('G8: Newmark SDOF at resonance, ζ=2%: steady amplitude = static × 25, within 2% after 50 cycles', () => {
    const mesh = unitSdofMesh();
    const damping = rayleighFit(0.02, 1, 1);
    let state: NewmarkState = {
      u: new Float64Array(6),
      v: new Float64Array(6),
      a: new Float64Array(6),
      t: 0,
      damping,
    };
    const dt = 0.01;
    const end = 50 * Math.PI * 2;
    let amplitude = 0;
    while (state.t < end) {
      state = newmarkStep(
        mesh,
        state,
        (time) => {
          const force = new Float64Array(6);
          force[3] = Math.sin(time); // unit harmonic force at ω = ω_n = 1 rad/s
          return force;
        },
        dt,
      );
      if (state.t > end - Math.PI * 2) amplitude = Math.max(amplitude, Math.abs(state.u[3]!));
    }
    expect(relativeError(amplitude, 25)).toBeLessThan(0.02);
  });

  it('G9: Rayleigh fit reproduces target ζ at ω₁ and ω₂ to 1e-6', () => {
    const target = 0.037;
    const [w1, w2] = [3.2, 17.8];
    const params = rayleighFit(target, w1, w2);
    expect(rayleighDampingRatio(params, w1)).toBeCloseTo(target, 6);
    expect(rayleighDampingRatio(params, w2)).toBeCloseTo(target, 6);
  });
});

describe('M6/M7 gates — failure & sharing', () => {
  it('G12: cascade on overloaded preset 4 reproduces frozen golden step sequence', () => {
    expect(evaluateFailure(overloadedRadioMast(), 1)).toMatchObject({ kind: 'buckling' });
    const cascade = collapseCascade(overloadedRadioMast());
    expect(cascade).toEqual({
      steps: [
        {
          action: 'remove',
          memberId: 1,
          detail: 'Member 1 buckled/was axial-governing and was removed.',
        },
      ],
      outcome: 'collapse',
    });
  });
  it('G11: property — decodeModel(encodeModel(m)) deep-equals m for seeded random models (both #m and #mu paths)', async () => {
    const random = mulberry32(0x0badc0de);
    for (let index = 0; index < 12; index++) {
      const model = shareModel(index + 1, random);
      const compressed = await encodeModel(model);
      expect(await decodeModel(compressed)).toEqual(model);
      const raw = new TextEncoder().encode(JSON.stringify(model));
      const uncompressed = `#mu=${base64url(raw)}`;
      expect(await decodeModel(uncompressed)).toEqual(model);
    }
  });
});

const DEFAULT_SECTION: SectionSpec = { kind: 'rect', b: 0.2, h: 0.3 };

function member(id: number, a: number, b: number): MemberSpec {
  return {
    id,
    a,
    b,
    material: 'steel-s355',
    section: DEFAULT_SECTION,
    releaseA: false,
    releaseB: false,
    cableOnly: false,
  };
}

function modelFor(
  nodes: EditorModel['nodes'],
  supports: SupportSpec[],
  members: MemberSpec[] = [member(1, nodes[0]?.id ?? 0, nodes[1]?.id ?? 0)],
): EditorModel {
  return {
    v: 1,
    name: 'test model',
    seed: 1,
    nodes,
    members,
    supports,
    loads: { gravity: false, points: [] },
    deck: [],
    story: { kind: 'ramp' },
  };
}

/** Unit EI pinned-pinned column with constrained endpoint translations. Gate G3/G3b. */
function pinnedColumnMesh(subdivisions: number): AnalysisMesh {
  const coords = new Float64Array((subdivisions + 1) * 2);
  for (let node = 0; node <= subdivisions; node++) coords[2 * node + 1] = node / subdivisions;
  const elements: AnalysisMesh['elements'] = [];
  for (let index = 0; index < subdivisions; index++) {
    elements.push({
      memberId: 1,
      na: index,
      nb: index + 1,
      L: 1 / subdivisions,
      E: 1,
      G: 1e12,
      A: 1,
      As: 1,
      I: 1,
      c: 1,
      rho: 1,
      fy: 1,
      cos: 0,
      sin: 1,
      releaseA: false,
      releaseB: false,
    });
  }
  const free: number[] = [2];
  for (let node = 1; node < subdivisions; node++) free.push(3 * node, 3 * node + 1, 3 * node + 2);
  free.push(3 * subdivisions + 2);
  return {
    coords,
    elements,
    editorNode: Int32Array.from({ length: subdivisions + 1 }, (_, index) => index + 1),
    freeDofs: Int32Array.from(free),
    ndof: (subdivisions + 1) * 3,
    shearFlexible: false,
  };
}

/** Unit EI/ρA simply-supported beam with axial DOFs held out of the bending gate. Gate G4. */
function simplySupportedBendingBeam(): AnalysisMesh {
  return {
    coords: Float64Array.of(0, 0, 0.5, 0, 1, 0),
    elements: [0, 1].map((index) => ({
      memberId: 1,
      na: index,
      nb: index + 1,
      L: 0.5,
      E: 1,
      G: 1e12,
      A: 1,
      As: 1,
      I: 1,
      c: 1,
      rho: 1,
      fy: 1,
      cos: 1,
      sin: 0,
      releaseA: false,
      releaseB: false,
    })),
    editorNode: Int32Array.of(1, -1, 2),
    // End translations are pinned; the midpoint axial DOF is constrained here
    // so this gate measures the stated transverse Euler–Bernoulli mode.
    freeDofs: Int32Array.of(2, 4, 5, 8),
    ndof: 9,
    shearFlexible: false,
  };
}

/** One free axial DOF with K=M=1 for the Newmark analytic gate. Gate G8. */
function unitSdofMesh(): AnalysisMesh {
  return {
    coords: Float64Array.of(0, 0, 1, 0),
    elements: [
      {
        memberId: 1,
        na: 0,
        nb: 1,
        L: 1,
        E: 1,
        G: 1e12,
        A: 1,
        As: 1,
        I: 1,
        c: 1,
        // Consistent axial mass at free node is ρAL / 3 = 1.
        rho: 3,
        fy: 1,
        cos: 1,
        sin: 0,
        releaseA: false,
        releaseB: false,
      },
    ],
    editorNode: Int32Array.of(1, 2),
    freeDofs: Int32Array.of(3),
    ndof: 6,
    shearFlexible: false,
  };
}

function shareModel(id: number, random: () => number): EditorModel {
  const span = 3 + random() * 8;
  const height = 1 + random() * 4;
  return {
    v: 1,
    name: `Shared ${id}`,
    seed: id,
    nodes: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: span, y: 0 },
      { id: 3, x: span / 2, y: height },
    ],
    members: [member(1, 1, 3), member(2, 3, 2), member(3, 1, 2)],
    supports: [
      { node: 1, kind: 'pin' },
      { node: 2, kind: 'roller' },
    ],
    loads: {
      gravity: random() > 0.5,
      points: [{ node: 3, fx: (random() - 0.5) * 1_000, fy: -random() * 5_000 }],
    },
    deck: [3],
    story: {
      kind: 'traffic',
      weightkN: 100 + random() * 300,
      speed: 5 + random() * 20,
      movingMass: false,
    },
  };
}

function overloadedRadioMast(): EditorModel {
  return {
    v: 1,
    name: 'Radio mast overload',
    seed: 4,
    nodes: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 0, y: 10 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: 'spaghetti',
        section: { kind: 'rect', b: 0.02, h: 0.02 },
        releaseA: false,
        releaseB: false,
        cableOnly: false,
      },
    ],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [{ node: 2, fx: 0, fy: -100 }] },
    deck: [],
    story: { kind: 'ramp' },
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function solveMesh(mesh: AnalysisMesh, F: Float64Array): { u: Float64Array } {
  const factored = factorLDLT(
    freeMatrix(assembleK(mesh), mesh.ndof, mesh.freeDofs),
    mesh.freeDofs.length,
  );
  if (!factored.ok)
    throw new Error(`Unexpected mechanism at free DOF ${factored.mechanism.freeDofIndex}.`);
  return {
    u: expandFreeVector(
      mesh.ndof,
      mesh.freeDofs,
      solveFactored(factored.factor, freeVector(F, mesh.freeDofs)),
    ),
  };
}

function mechanismNode(mesh: AnalysisMesh): number {
  const factored = factorLDLT(
    freeMatrix(assembleK(mesh), mesh.ndof, mesh.freeDofs),
    mesh.freeDofs.length,
  );
  if (factored.ok) throw new Error('Expected a structural mechanism.');
  return mechanismEditorNode(mesh, factored.mechanism.freeDofIndex);
}

function pointLoad(ndof: number, dof: number, value: number): Float64Array {
  const F = new Float64Array(ndof);
  F[dof] = value;
  return F;
}

function residual(K: Float64Array, u: Float64Array, F: Float64Array, ndof: number): Float64Array {
  const out = new Float64Array(ndof);
  for (let i = 0; i < ndof; i++) {
    let value = -F[i]!;
    for (let j = 0; j < ndof; j++) value += K[i * ndof + j]! * u[j]!;
    out[i] = value;
  }
  return out;
}

function localElementDisplacement(
  u: Float64Array,
  na: number,
  nb: number,
  cos: number,
  sin: number,
): Float64Array {
  const local = new Float64Array(6);
  for (const [localOffset, node] of [
    [0, na],
    [3, nb],
  ] as const) {
    const x = u[3 * node]!;
    const y = u[3 * node + 1]!;
    local[localOffset] = cos * x + sin * y;
    local[localOffset + 1] = -sin * x + cos * y;
    local[localOffset + 2] = u[3 * node + 2]!;
  }
  return local;
}

function multiplyMatrixVector(matrix: Float64Array, vector: Float64Array): Float64Array {
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    for (let j = 0; j < vector.length; j++) {
      out[i] = out[i]! + matrix[i * vector.length + j]! * vector[j]!;
    }
  }
  return out;
}

function relativeError(actual: number, expected: number): number {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) / scale;
}
