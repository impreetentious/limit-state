/**
 * Phase 3 space-frame honesty gates G22–G24.
 */
import { describe, expect, it } from 'vitest';
import { sectionProps } from '../materials';
import { analyzeStaticModel } from '../statics';
import type { EditorModel } from '../types';
import {
  analyzeStaticModel3d,
  assembleF3d,
  assembleK3d,
  assembleM3d,
  buckling3d,
  buildMesh3d,
  externalWork3d,
  kgLocal3d,
  kLocal3d,
  memberTriad,
  mLocal3d,
  modal3d,
  NO_RELEASES,
  prepareStaticSystem3d,
  solveStatic3d,
  strainEnergy3d,
  transformToGlobal3d,
  type AnalysisMesh3d,
  type EditorModel3d,
  type Element3d,
} from '../space';

describe('Phase 3 — section props for 3D (Iy, Iz, J)', () => {
  it('G10 extended: Iy/Iz/J vs hand calcs', () => {
    const r = sectionProps({ kind: 'rect', b: 0.2, h: 0.4 });
    expect(r.Iz).toBeCloseTo((0.2 * 0.4 ** 3) / 12, 15);
    expect(r.Iy).toBeCloseTo((0.4 * 0.2 ** 3) / 12, 15);
    expect(r.I).toBe(r.Iz);
    expect(r.J).toBeGreaterThan(0);
    // Solid rect J < polar Iy+Iz (St. Venant, not warping-free circle).
    expect(r.J).toBeLessThan(r.Iy + r.Iz);

    const t = sectionProps({ kind: 'tube', d: 0.2, t: 0.01 });
    expect(t.J).toBeCloseTo(2 * t.I, 12);
    expect(t.Iy).toBeCloseTo(t.Iz, 12);

    const box = sectionProps({ kind: 'box', b: 0.2, h: 0.2, t: 0.008 });
    expect(box.J).toBeGreaterThan(0);
    expect(box.Iy).toBeCloseTo(box.Iz, 12);
  });
});

describe('Phase 3 — G22 3D cantilever closed forms', () => {
  it('kLocal3d is symmetric with axial/torsion/bending entries', () => {
    const k = kLocal3d(1, 1, 1, 1, 1, 1, 1);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) expect(k[i * 12 + j]).toBeCloseTo(k[j * 12 + i]!, 12);
    expect(k[0]).toBeCloseTo(1, 12); // EA/L
    expect(k[3 * 12 + 3]).toBeCloseTo(1, 12); // GJ/L
    expect(k[1 * 12 + 1]).toBeCloseTo(12, 12); // 12 EIz / L³
    expect(k[2 * 12 + 2]).toBeCloseTo(12, 12); // 12 EIy / L³
  });

  it('G22: tip P_y, P_z, T_x match PL³/3EI and TL/GJ (1 elem, rel < 1e-10)', () => {
    // Unit properties, one analysis element, root fixed.
    const mesh = unitCantileverMesh();
    const system = prepareStaticSystem3d(mesh);
    if ('mechanismFreeDof' in system) throw new Error('unit cantilever must be stable');

    // +Fy at tip → v = 1/3, θz = 1/2
    {
      const { F } = assembleF3d(mesh, [{ meshNode: 1, fx: 0, fy: 1, fz: 0 }]);
      const analysis = solveStatic3d(mesh, F, system);
      if (analysis.kind !== 'stable') throw new Error(analysis.message);
      expect(analysis.result.u[6 + 1]! / (1 / 3)).toBeCloseTo(1, 10);
      expect(analysis.result.u[6 + 5]! / (1 / 2)).toBeCloseTo(1, 10);
    }

    // +Fz at tip → w = 1/3, θy = −1/2 (RH sign on k_y)
    {
      const { F } = assembleF3d(mesh, [{ meshNode: 1, fx: 0, fy: 0, fz: 1 }]);
      const analysis = solveStatic3d(mesh, F, system);
      if (analysis.kind !== 'stable') throw new Error(analysis.message);
      expect(analysis.result.u[6 + 2]! / (1 / 3)).toBeCloseTo(1, 10);
      expect(analysis.result.u[6 + 4]! / (-1 / 2)).toBeCloseTo(1, 10);
    }

    // +Tx at tip → θx = TL/GJ = 1
    {
      const { F } = assembleF3d(mesh, [{ meshNode: 1, fx: 0, fy: 0, fz: 0, mx: 1 }]);
      const analysis = solveStatic3d(mesh, F, system);
      if (analysis.kind !== 'stable') throw new Error(analysis.message);
      expect(analysis.result.u[6 + 3]!).toBeCloseTo(1, 10);
    }
  });

  it('transformToGlobal3d preserves symmetry and trace', () => {
    const k = kLocal3d(2, 3, 4, 0.5, 0.7, 0.9, 1.7);
    const R = memberTriad(1, 2, 3, 0.4);
    const kg = transformToGlobal3d(k, R);
    let trLocal = 0;
    let trGlobal = 0;
    for (let i = 0; i < 12; i++) {
      trLocal += k[i * 12 + i]!;
      trGlobal += kg[i * 12 + i]!;
      for (let j = 0; j < 12; j++) expect(kg[i * 12 + j]).toBeCloseTo(kg[j * 12 + i]!, 9);
    }
    expect(trGlobal).toBeCloseTo(trLocal, 9);
  });
});

describe('Phase 3 — G23 2D↔3D regression', () => {
  it('G23: planar XY cantilever tip matches 2D analyzeStaticModel to 1e-9', () => {
    const L = 8;
    const P = -50e3; // N, global −y
    const section = { kind: 'rect' as const, b: 0.15, h: 0.3 };
    const material = 'steel-s355' as const;

    const model2d: EditorModel = {
      v: 1,
      name: 'cantilever-2d',
      seed: 0,
      nodes: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: L, y: 0 },
      ],
      members: [
        {
          id: 1,
          a: 1,
          b: 2,
          material,
          section,
          releaseA: false,
          releaseB: false,
          cableOnly: false,
        },
      ],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [{ node: 2, fx: 0, fy: P }] },
      deck: [],
      story: { kind: 'ramp' },
    };

    const model3d: EditorModel3d = {
      v: 2,
      name: 'cantilever-3d',
      seed: 0,
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: L, y: 0, z: 0 },
      ],
      members: [
        {
          id: 1,
          a: 1,
          b: 2,
          material,
          section,
          releaseA: NO_RELEASES,
          releaseB: NO_RELEASES,
          roll: 0,
        },
      ],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [{ node: 2, fx: 0, fy: P, fz: 0 }] },
    };

    const a2 = analyzeStaticModel(model2d);
    const a3 = analyzeStaticModel3d(model3d);
    if (a2.kind !== 'stable') throw new Error(a2.message);
    if (a3.kind !== 'stable') throw new Error(a3.message);

    // 2D tip: node 1 (0-based mesh index of editor node 2) → DOFs [3,4,5]
    const tip2 = a2.mesh.editorNode.findIndex((id) => id === 2);
    const v2 = a2.result.u[3 * tip2 + 1]!;
    const th2 = a2.result.u[3 * tip2 + 2]!;

    const tip3 = a3.mesh.editorNode.findIndex((id) => id === 2);
    const v3 = a3.result.u[6 * tip3 + 1]!;
    const th3 = a3.result.u[6 * tip3 + 5]!; // θz
    const w3 = a3.result.u[6 * tip3 + 2]!;

    expect(Math.abs(v3 - v2) / Math.max(Math.abs(v2), 1e-30)).toBeLessThan(1e-9);
    expect(Math.abs(th3 - th2) / Math.max(Math.abs(th2), 1e-30)).toBeLessThan(1e-9);
    expect(Math.abs(w3)).toBeLessThan(1e-14 * Math.max(1, Math.abs(v3)));
  });
});

describe('Phase 3 — G24 space corner frame', () => {
  it('G24: orthogonal corner — ΣF = P, K symmetric, W = U', () => {
    // Two members: along +X then along +Z from the elbow; load at free tip in +Y.
    const model: EditorModel3d = {
      v: 2,
      name: 'space-corner',
      seed: 0,
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 4, y: 0, z: 0 },
        { id: 3, x: 4, y: 0, z: 3 },
      ],
      members: [
        {
          id: 1,
          a: 1,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'rect', b: 0.1, h: 0.2 },
          releaseA: NO_RELEASES,
          releaseB: NO_RELEASES,
          roll: 0,
        },
        {
          id: 2,
          a: 2,
          b: 3,
          material: 'steel-s355',
          section: { kind: 'rect', b: 0.1, h: 0.2 },
          releaseA: NO_RELEASES,
          releaseB: NO_RELEASES,
          roll: 0,
        },
      ],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [{ node: 3, fx: 0, fy: -10e3, fz: 0 }] },
    };

    const mesh = buildMesh3d(model);
    const K = assembleK3d(mesh);
    for (let i = 0; i < mesh.ndof; i++)
      for (let j = 0; j < mesh.ndof; j++) expect(K[i * mesh.ndof + j]).toBeCloseTo(K[j * mesh.ndof + i]!, 9);

    const analysis = analyzeStaticModel3d(model);
    if (analysis.kind !== 'stable') throw new Error(analysis.message);

    let rx = 0;
    let ry = 0;
    let rz = 0;
    for (const reaction of analysis.result.reactions.values()) {
      rx += reaction.fx;
      ry += reaction.fy;
      rz += reaction.fz;
    }
    expect(rx).toBeCloseTo(0, 8);
    expect(ry).toBeCloseTo(10e3, 6);
    expect(rz).toBeCloseTo(0, 8);

    const tip = analysis.mesh.editorNode.findIndex((id) => id === 3);
    const { F } = assembleF3d(mesh, [{ meshNode: tip, fx: 0, fy: -10e3, fz: 0 }]);
    const U = strainEnergy3d(K, analysis.result.u, mesh.ndof);
    const W = externalWork3d(analysis.result.u, F);
    expect(Math.abs(U - W) / Math.max(Math.abs(W), 1e-30)).toBeLessThan(1e-9);
  });
});

describe('Phase 3 — kg / M / G25 Euler buckling', () => {
  it('kgLocal3d and mLocal3d are symmetric with conserved translational mass', () => {
    const g = kgLocal3d(-1, 1);
    const m = mLocal3d(1, 1, 1, 1, 1);
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        expect(g[i * 12 + j]).toBeCloseTo(g[j * 12 + i]!, 12);
        expect(m[i * 12 + j]).toBeCloseTo(m[j * 12 + i]!, 12);
      }
    }
    // Translational mass per direction sums to ρ A L.
    for (const idxs of [
      [0, 6],
      [1, 7],
      [2, 8],
    ]) {
      let sum = 0;
      for (const i of idxs) for (const j of idxs) sum += m[i * 12 + j]!;
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it('G25: 3D pinned column λ_cr within +0.8% of π² (2 elems, unit EI)', () => {
    const mesh = pinnedColumnMesh3dEmbed(2);
    const result = buckling3d(mesh, Float64Array.of(-1, -1));
    expect(result.kind).toBe('buckling');
    expect(result.values.length).toBeGreaterThan(0);
    const err = Math.abs(result.values[0]! - Math.PI ** 2) / Math.PI ** 2;
    expect(err).toBeLessThan(0.008);
  });

  it('assembleM3d total translational mass matches Σ ρ A L', () => {
    const model: EditorModel3d = {
      v: 2,
      name: 'mass-check',
      seed: 0,
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 2, y: 0, z: 0 },
      ],
      members: [
        {
          id: 1,
          a: 1,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'rect', b: 0.1, h: 0.1 },
          releaseA: NO_RELEASES,
          releaseB: NO_RELEASES,
          roll: 0,
        },
      ],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [] },
    };
    const mesh = buildMesh3d(model);
    const M = assembleM3d(mesh);
    let expected = 0;
    for (const el of mesh.elements) expected += el.rho * el.A * el.L;
    for (const component of [0, 1, 2]) {
      let sum = 0;
      for (let i = 0; i < mesh.editorNode.length; i++) {
        for (let j = 0; j < mesh.editorNode.length; j++) {
          sum += M[(6 * i + component) * mesh.ndof + (6 * j + component)]!;
        }
      }
      expect(sum).toBeCloseTo(expected, 8);
    }
  });
});

describe('Phase 3 — G26 modal + G27 spatial buckling', () => {
  it('G26: SS beam ω₁ within +0.5% of π² (2 elems); biaxial modes scale with √I', () => {
    // Embed of G4 — same measured +0.39%.
    const embed = modal3d(simplySupportedBeam3dEmbed(), 1);
    expect(embed.kind).toBe('modal');
    expect(Math.abs(embed.values[0]! - Math.PI ** 2) / Math.PI ** 2).toBeLessThan(0.005);

    // Both bending planes free, Iy=4, Iz=1 → ω ∝ √I.
    const biaxial = modal3d(simplySupportedBeam3dBiaxial(4, 1), 2);
    expect(biaxial.values.length).toBe(2);
    const wIz = Math.PI ** 2; // √1
    const wIy = Math.PI ** 2 * 2; // √4
    expect(Math.abs(biaxial.values[0]! - wIz) / wIz).toBeLessThan(0.005);
    expect(Math.abs(biaxial.values[1]! - wIy) / wIy).toBeLessThan(0.005);
  });

  it('G27: spatial pinned column — full 3D DOFs; λ_cr follows weak-axis π² E I_min / L²', () => {
    // Equal principal inertias: same measured +0.75% as G3/G25.
    const equal = buckling3d(spatialPinnedColumn(2, 1, 1), Float64Array.of(-1, -1));
    expect(equal.kind).toBe('buckling');
    expect(Math.abs(equal.values[0]! - Math.PI ** 2) / Math.PI ** 2).toBeLessThan(0.008);

    // Weak axis Iz=0.5 governs: P_cr = π² E Iz / L² with |N_ref|=1 ⇒ λ = π²/2.
    const weak = buckling3d(spatialPinnedColumn(2, 1, 0.5), Float64Array.of(-1, -1));
    const expectWeak = (Math.PI ** 2) * 0.5;
    expect(Math.abs(weak.values[0]! - expectWeak) / expectWeak).toBeLessThan(0.008);
  });
});

describe('Phase 3 — G28 schema v2 migration', () => {
  it('G28: golden v1 decode identical; migrateV1toV2 + encode/decode3d round-trip', async () => {
    const { decodeModel, encodeModel, encodeModel3d, decodeModel3d, migrateV1toV2 } = await import('../../share/serialize');
    const v1: EditorModel = {
      v: 1,
      name: 'migrate-beam',
      seed: 42,
      nodes: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 8, y: 0 },
      ],
      members: [{
        id: 1,
        a: 1,
        b: 2,
        material: 'steel-s355',
        section: { kind: 'rect', b: 0.15, h: 0.3 },
        releaseA: false,
        releaseB: false,
        cableOnly: false,
      }],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [{ node: 2, fx: 0, fy: -1e3 }] },
      deck: [],
      story: { kind: 'ramp' },
    };
    const hash = await encodeModel(v1);
    expect(await decodeModel(hash)).toEqual(v1);

    const v2 = migrateV1toV2(v1);
    expect(v2.v).toBe(2);
    expect(v2.nodes.every((n) => n.z === 0)).toBe(true);
    expect(v2.members[0]!.roll).toBe(0);
    const round = await decodeModel3d(await encodeModel3d(v2));
    expect(round).toEqual(v2);
  });
});

/** Single-element unit cantilever along +X for closed-form gates. */
function unitCantileverMesh(): AnalysisMesh3d {
  const R = memberTriad(1, 0, 0, 0);
  const element: Element3d = {
    memberId: 1,
    na: 0,
    nb: 1,
    E: 1,
    G: 1,
    A: 1,
    Iy: 1,
    Iz: 1,
    J: 1,
    c: 1,
    fy: 1,
    rho: 1,
    L: 1,
    R,
    releaseA: NO_RELEASES,
    releaseB: NO_RELEASES,
  };
  return {
    coords: Float64Array.of(0, 0, 0, 1, 0, 0),
    elements: [element],
    editorNode: Int32Array.of(1, 2),
    freeDofs: Int32Array.of(6, 7, 8, 9, 10, 11), // tip all 6 free; root fixed
    ndof: 12,
  };
}

/**
 * Unit-EI pinned-pinned column along +X with the 2D G3 DOF pattern embedded
 * in 3D (active: ux, uy, θz; uz/θx/θy constrained). Verifies the space-frame
 * matrices reduce to the measured 2D Euler gate. Gate G25.
 */
function pinnedColumnMesh3dEmbed(subdivisions: number): AnalysisMesh3d {
  const coords = new Float64Array((subdivisions + 1) * 3);
  for (let node = 0; node <= subdivisions; node++) coords[3 * node] = node / subdivisions;
  const elements: Element3d[] = [];
  for (let index = 0; index < subdivisions; index++) {
    const L = 1 / subdivisions;
    elements.push({
      memberId: 1,
      na: index,
      nb: index + 1,
      L,
      E: 1,
      G: 1e12,
      A: 1,
      Iy: 1,
      Iz: 1,
      J: 1,
      c: 1,
      fy: 1,
      rho: 1,
      R: memberTriad(L, 0, 0, 0),
      releaseA: NO_RELEASES,
      releaseB: NO_RELEASES,
    });
  }
  // Mirror 2D G3 free-DOF list inside the 6-DOF-per-node numbering.
  const free: number[] = [5]; // base θz
  for (let node = 1; node < subdivisions; node++) {
    free.push(6 * node, 6 * node + 1, 6 * node + 5); // ux, uy, θz
  }
  free.push(6 * subdivisions + 5); // top θz
  return {
    coords,
    elements,
    editorNode: Int32Array.from({ length: subdivisions + 1 }, (_, index) => index + 1),
    freeDofs: Int32Array.from(free),
    ndof: (subdivisions + 1) * 6,
  };
}

/** G4 DOF pattern embedded in 3D. Gate G26. */
function simplySupportedBeam3dEmbed(): AnalysisMesh3d {
  const elements: Element3d[] = [0, 1].map((index) => ({
    memberId: 1,
    na: index,
    nb: index + 1,
    L: 0.5,
    E: 1,
    G: 1,
    A: 1,
    Iy: 1,
    Iz: 1,
    J: 1,
    c: 1,
    fy: 1,
    rho: 1,
    R: memberTriad(0.5, 0, 0, 0),
    releaseA: NO_RELEASES,
    releaseB: NO_RELEASES,
  }));
  // 2D freeDofs [2,4,5,8] → base θz, mid uy, mid θz, top θz.
  return {
    coords: Float64Array.of(0, 0, 0, 0.5, 0, 0, 1, 0, 0),
    elements,
    editorNode: Int32Array.of(1, -1, 2),
    freeDofs: Int32Array.of(5, 7, 11, 17),
    ndof: 18,
  };
}

/** Both bending planes free; axial mid DOF held out. Gate G26. */
function simplySupportedBeam3dBiaxial(Iy: number, Iz: number): AnalysisMesh3d {
  const elements: Element3d[] = [0, 1].map((index) => ({
    memberId: 1,
    na: index,
    nb: index + 1,
    L: 0.5,
    E: 1,
    G: 1,
    A: 1,
    Iy,
    Iz,
    J: 1,
    c: 1,
    fy: 1,
    rho: 1,
    R: memberTriad(0.5, 0, 0, 0),
    releaseA: NO_RELEASES,
    releaseB: NO_RELEASES,
  }));
  return {
    coords: Float64Array.of(0, 0, 0, 0.5, 0, 0, 1, 0, 0),
    elements,
    editorNode: Int32Array.of(1, -1, 2),
    // Ends: θy, θz free (translations pinned). Mid: uy, uz, θy, θz.
    freeDofs: Int32Array.of(4, 5, 7, 8, 10, 11, 16, 17),
    ndof: 18,
  };
}

/**
 * Spatial pinned-pinned column along +Z with both bending planes active.
 * Torsion about the column restrained at the pins (lone shaft RB mode).
 * G=1 keeps K well-conditioned with torsional mid DOFs present. Gate G27.
 */
function spatialPinnedColumn(subdivisions: number, Iy: number, Iz: number): AnalysisMesh3d {
  const coords = new Float64Array((subdivisions + 1) * 3);
  for (let node = 0; node <= subdivisions; node++) coords[3 * node + 2] = node / subdivisions;
  const elements: Element3d[] = [];
  for (let index = 0; index < subdivisions; index++) {
    const L = 1 / subdivisions;
    elements.push({
      memberId: 1,
      na: index,
      nb: index + 1,
      L,
      E: 1,
      G: 1,
      A: 1,
      Iy,
      Iz,
      J: 1,
      c: 1,
      fy: 1,
      rho: 1,
      R: memberTriad(0, 0, L, 0),
      releaseA: NO_RELEASES,
      releaseB: NO_RELEASES,
    });
  }
  const free: number[] = [3, 4]; // base θx, θy (not θz torsion)
  for (let node = 1; node < subdivisions; node++) {
    for (let c = 0; c < 6; c++) free.push(6 * node + c);
  }
  free.push(6 * subdivisions + 3, 6 * subdivisions + 4);
  return {
    coords,
    elements,
    editorNode: Int32Array.from({ length: subdivisions + 1 }, (_, index) => index + 1),
    freeDofs: Int32Array.from(free),
    ndof: (subdivisions + 1) * 6,
  };
}
