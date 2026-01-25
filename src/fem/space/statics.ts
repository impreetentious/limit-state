/**
 * 3D static solve: assemble → LDLᵀ free partition → expand.
 * Reuses the dimension-agnostic factor/solve from fem/solve.ts.
 */
import { expandFreeVector, factorLDLT, freeMatrix, freeVector, solveFactored, type Factor } from '../solve';
import { assembleF3d, assembleK3d, elementLocalStiffness3d } from './assemble';
import { buildMesh3d } from './mesh';
import type { AnalysisMesh3d, EditorModel3d, StaticResult3d } from './types';

export type StaticAnalysis3d =
  | { kind: 'stable'; mesh: AnalysisMesh3d; result: StaticResult3d }
  | { kind: 'mechanism'; freeDofIndex: number; message: string }
  | { kind: 'invalid'; message: string };

export type StaticSystem3d =
  | { ndof: number; K: Float64Array; factor: Factor }
  | { ndof: number; K: Float64Array; mechanismFreeDof: number };

/** Assemble and factor once. */
export function prepareStaticSystem3d(mesh: AnalysisMesh3d): StaticSystem3d {
  const K = assembleK3d(mesh);
  const result = factorLDLT(freeMatrix(K, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  return result.ok
    ? { ndof: mesh.ndof, K, factor: result.factor }
    : { ndof: mesh.ndof, K, mechanismFreeDof: result.mechanism.freeDofIndex };
}

/** Solve one 3D static load case. */
export function solveStatic3d(
  mesh: AnalysisMesh3d,
  F: Float64Array,
  cachedSystem?: StaticSystem3d,
): StaticAnalysis3d {
  const system = cachedSystem ?? prepareStaticSystem3d(mesh);
  if (system.ndof !== mesh.ndof) return { kind: 'invalid', message: 'Static system does not match this analysis mesh.' };
  if ('mechanismFreeDof' in system) {
    return {
      kind: 'mechanism',
      freeDofIndex: system.mechanismFreeDof,
      message: `Free DOF ${system.mechanismFreeDof} indicates a mechanism.`,
    };
  }
  const u = expandFreeVector(mesh.ndof, mesh.freeDofs, solveFactored(system.factor, freeVector(F, mesh.freeDofs)));
  const elementForces = recoverElementForces3d(mesh, u);
  return {
    kind: 'stable',
    mesh,
    result: {
      u,
      elementForces,
      utilization: recoverUtilization3d(mesh, elementForces),
      reactions: recoverReactions3d(mesh, system.K, u, F),
    },
  };
}

/** Build mesh + solve the model's nodal load case. */
export function analyzeStaticModel3d(model: EditorModel3d): StaticAnalysis3d {
  try {
    const mesh = buildMesh3d(model);
    const nodeIndex = new Map<number, number>();
    for (let index = 0; index < mesh.editorNode.length; index++) {
      const id = mesh.editorNode[index]!;
      if (id >= 0) nodeIndex.set(id, index);
    }
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined
        ? []
        : [{ meshNode, fx: point.fx, fy: point.fy, fz: point.fz, mx: point.mx, my: point.my, mz: point.mz }];
    });
    const { F } = assembleF3d(mesh, points);
    return solveStatic3d(mesh, F);
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : '3D static analysis could not run.' };
  }
}

function recoverElementForces3d(mesh: AnalysisMesh3d, u: Float64Array): Float64Array {
  const out = new Float64Array(mesh.elements.length * 12);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const k = elementLocalStiffness3d(element);
    const ug = new Float64Array(12);
    const a = 6 * element.na;
    const b = 6 * element.nb;
    for (let i = 0; i < 6; i++) {
      ug[i] = u[a + i]!;
      ug[6 + i] = u[b + i]!;
    }
    // Local displacements: d_local = T d_global = blkdiag(R,…) · ug.
    const ul = new Float64Array(12);
    for (let blk = 0; blk < 4; blk++) {
      const o = blk * 3;
      const gx = ug[o]!;
      const gy = ug[o + 1]!;
      const gz = ug[o + 2]!;
      const R = element.R;
      ul[o] = R[0]! * gx + R[1]! * gy + R[2]! * gz;
      ul[o + 1] = R[3]! * gx + R[4]! * gy + R[5]! * gz;
      ul[o + 2] = R[6]! * gx + R[7]! * gy + R[8]! * gz;
    }
    for (let i = 0; i < 12; i++) {
      let force = 0;
      for (let j = 0; j < 12; j++) force += k[i * 12 + j]! * ul[j]!;
      out[index * 12 + i] = force;
    }
  }
  return out;
}

/**
 * Combined-stress utilization |N/A ± My·c/Iy ± Mz·c/Iz| / fy at both ends.
 */
function recoverUtilization3d(mesh: AnalysisMesh3d, forces: Float64Array): Map<number, number> {
  const utilization = new Map<number, number>();
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const base = index * 12;
    // Tension-positive internal N = −Fx at end A (nodal reaction convention).
    const Na = -forces[base]!;
    const Nb = forces[base + 6]!;
    const Mya = forces[base + 4]!;
    const Mza = forces[base + 5]!;
    const Myb = forces[base + 10]!;
    const Mzb = forces[base + 11]!;
    const cy = element.c ?? 0; // fiber for Iz (local y extreme ≈ section half-depth)
    const cz = element.c ?? 0; // same extreme for square-ish sections; rect uses h/2 for both gates
    const fy = element.fy ?? Number.POSITIVE_INFINITY;
    const u = Math.max(
      fiberUtilization3d(Na, Mya, Mza, element.A, element.Iy, element.Iz, cy, cz, fy),
      fiberUtilization3d(Nb, Myb, Mzb, element.A, element.Iy, element.Iz, cy, cz, fy),
    );
    utilization.set(element.memberId, Math.max(utilization.get(element.memberId) ?? 0, u));
  }
  return utilization;
}

function fiberUtilization3d(
  N: number,
  My: number,
  Mz: number,
  A: number,
  Iy: number,
  Iz: number,
  cy: number,
  cz: number,
  fy: number,
): number {
  if (!(fy > 0)) return 0;
  const axial = Math.abs(N) / A;
  const bending = Math.abs(My) * cy / Math.max(Iy, 1e-30) + Math.abs(Mz) * cz / Math.max(Iz, 1e-30);
  return Math.max(axial + bending, Math.abs(axial - bending)) / fy;
}

/** Honest display amplification sized to a legible ~28 px screen displacement. */
export function deformationDisplay3d(
  mesh: AnalysisMesh3d,
  u: Float64Array,
  pixelsPerMeter: number,
): { maxMeters: number; scale: number } {
  let maxMeters = 0;
  for (let node = 0; mesh.coords.length > node * 3; node++) {
    maxMeters = Math.max(
      maxMeters,
      Math.hypot(u[6 * node]!, u[6 * node + 1]!, u[6 * node + 2]!),
    );
  }
  if (maxMeters === 0) return { maxMeters, scale: 1 };
  return { maxMeters, scale: Math.max(1, Math.min(100_000, 28 / (maxMeters * pixelsPerMeter))) };
}

function recoverReactions3d(
  mesh: AnalysisMesh3d,
  K: Float64Array,
  u: Float64Array,
  F: Float64Array,
): Map<number, { fx: number; fy: number; fz: number; mx: number; my: number; mz: number }> {
  const reactions = new Map<number, { fx: number; fy: number; fz: number; mx: number; my: number; mz: number }>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const editorId = mesh.editorNode[node]!;
    if (editorId < 0) continue;
    const base = 6 * node;
    const r = { fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 };
    let any = false;
    for (let c = 0; c < 6; c++) {
      const dof = base + c;
      // Reaction = (Ku − F) on constrained DOFs; free DOFs should be ~0.
      let ku = 0;
      for (let j = 0; j < mesh.ndof; j++) ku += K[dof * mesh.ndof + j]! * u[j]!;
      const value = ku - F[dof]!;
      if (Math.abs(value) > 1e-14) any = true;
      if (c === 0) r.fx = value;
      if (c === 1) r.fy = value;
      if (c === 2) r.fz = value;
      if (c === 3) r.mx = value;
      if (c === 4) r.my = value;
      if (c === 5) r.mz = value;
    }
    if (any) reactions.set(editorId, r);
  }
  return reactions;
}

/** Strain energy ½ uᵀ K u. Gate G24. */
export function strainEnergy3d(K: Float64Array, u: Float64Array, ndof: number): number {
  let energy = 0;
  for (let i = 0; i < ndof; i++) {
    let ku = 0;
    for (let j = 0; j < ndof; j++) ku += K[i * ndof + j]! * u[j]!;
    energy += u[i]! * ku;
  }
  return 0.5 * energy;
}

/** External work ½ uᵀ F at equilibrium. Gate G24. */
export function externalWork3d(u: Float64Array, F: Float64Array): number {
  let work = 0;
  for (let i = 0; i < u.length; i++) work += u[i]! * F[i]!;
  return 0.5 * work;
}
