/**
 * The honesty gates. Tolerances are measured, not aspirational
 * (they were validated numerically before the plan was written; see §13.A).
 * Each milestone converts its `it.todo` rows into real tests.
 */
import { describe, expect, it } from 'vitest';
import { assembleF, assembleK, elementLocalStiffness, kLocal, kgLocal, mLocal, transformToGlobal } from '../assemble';
import { sectionProps } from '../materials';
import { buildMesh } from '../mesh';
import { expandFreeVector, factorLDLT, freeMatrix, freeVector, mechanismEditorNode, solveFactored } from '../solve';
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
    expect(k[0]).toBeCloseTo(E * A / L, 12); // EA/L
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
    const t = sectionProps({ kind: 'tube', d: 0.2, t: 0.01 });
    expect(t.A).toBeCloseTo((Math.PI / 4) * (0.2 ** 2 - 0.18 ** 2), 12);
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
      [{ node: 1, kind: 'pin' }, { node: 2, kind: 'roller' }],
    );
    const mesh = buildMesh(model);
    const result = solveMesh(mesh, assembleF(mesh, {
      gravity: false,
      points: [],
      elementUdls: mesh.elements.map((_, element) => ({ element, w })),
    }));
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
      const mesh = buildMesh(modelFor(
        [
          { id: 1, x: 0, y: 0 },
          { id: 2, x: width, y: 0 },
          { id: 3, x: width / 2 + (random() - 0.5), y: height },
        ],
        [{ node: 1, kind: 'fixed' }, { node: 2, kind: 'fixed' }],
        [
          member(1, 1, 3),
          member(2, 3, 2),
          member(3, 1, 2),
        ],
      ));
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

    const underbraced = buildMesh(modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 4, y: 0 },
      ],
      [{ node: 1, kind: 'pin' }],
    ));
    expect(mechanismNode(underbraced)).toBe(2);
  });

  it('G7: released truss members carry |M| < 1e-8 under nodal loads', () => {
    const trussMember = (id: number, a: number, b: number): MemberSpec => ({
      ...member(id, a, b),
      releaseA: true,
      releaseB: true,
    });
    const mesh = buildMesh(modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 4, y: 0 },
        { id: 3, x: 2, y: 3 },
      ],
      [{ node: 1, kind: 'pin' }, { node: 2, kind: 'roller' }],
      [trussMember(1, 1, 2), trussMember(2, 1, 3), trussMember(3, 3, 2)],
    ));
    const apex = mesh.editorNode.findIndex((id) => id === 3);
    const result = solveMesh(mesh, pointLoad(mesh.ndof, 3 * apex + 1, -100_000));

    for (const element of mesh.elements) {
      const localU = localElementDisplacement(result.u, element.na, element.nb, element.cos, element.sin);
      const stiffness = elementLocalStiffness(element);
      const endForces = multiplyMatrixVector(stiffness, localU);
      expect(Math.abs(endForces[2]!)).toBeLessThan(1e-8);
      expect(Math.abs(endForces[5]!)).toBeLessThan(1e-8);
    }
  });

  it('G13: in-element point loads conserve reaction and are continuous at a mesh node', () => {
    const mesh = buildMesh(modelFor(
      [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 8, y: 0 },
      ],
      [{ node: 1, kind: 'pin' }, { node: 2, kind: 'roller' }],
    ));
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

    const fromLeft = solveMesh(mesh, assembleF(mesh, {
      gravity: false,
      points: [],
      inElement: [{ element: 0, xi: 1, p: P }],
    }));
    const fromRight = solveMesh(mesh, assembleF(mesh, {
      gravity: false,
      points: [],
      inElement: [{ element: 1, xi: 0, p: P }],
    }));
    for (let dof = 0; dof < mesh.ndof; dof++) {
      expect(relativeError(fromLeft.u[dof]!, fromRight.u[dof]!)).toBeLessThan(1e-12);
    }
  });
});

describe('M4 gates — eigenanalysis', () => {
  it.todo('G3: pinned column λ_cr = 9.9438 (2 elem) vs π² = 9.8696, within +0.8% (measured +0.75%)');
  it.todo('G3b: 4 elem λ_cr within +0.1% of π² (measured +0.051%)');
  it.todo('G4: SS beam ω₁ = 9.9086 (2 elem) vs π² rad/s, within +0.5% (measured +0.39%)');
});

describe('M5 gates — dynamics', () => {
  it.todo('G8: Newmark SDOF at resonance, ζ=2%: steady amplitude = static × 25, within 2% after 50 cycles');
  it.todo('G9: Rayleigh fit reproduces target ζ at ω₁ and ω₂ to 1e-6');
});

describe('M6/M7 gates — failure & sharing', () => {
  it.todo('G12: cascade on overloaded preset 4 reproduces frozen golden step sequence');
  it.todo('G11: property — decodeModel(encodeModel(m)) deep-equals m for seeded random models (both #m and #mu paths)');
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

function solveMesh(mesh: AnalysisMesh, F: Float64Array): { u: Float64Array } {
  const factored = factorLDLT(freeMatrix(assembleK(mesh), mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  if (!factored.ok) throw new Error(`Unexpected mechanism at free DOF ${factored.mechanism.freeDofIndex}.`);
  return { u: expandFreeVector(mesh.ndof, mesh.freeDofs, solveFactored(factored.factor, freeVector(F, mesh.freeDofs))) };
}

function mechanismNode(mesh: AnalysisMesh): number {
  const factored = factorLDLT(freeMatrix(assembleK(mesh), mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
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
  for (const [localOffset, node] of [[0, na], [3, nb]] as const) {
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

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
