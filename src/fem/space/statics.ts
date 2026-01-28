/**
 * 3D static solve: assemble skyline K → free LDLᵀ → expand.
 */
import {
  factorSkylineLDLT,
  freeSkyline,
  matvecSkyline,
  solveSkylineFactored,
  type SkylineFactor,
  type SkylineMatrix,
} from '../skyline';
import { expandFreeVector, freeVector } from '../solve';
import { assembleK3d, assembleLoadCase3d, elementLocalStiffness3d } from './assemble';
import { buildMesh3d } from './mesh';
import type { AnalysisMesh3d, AnalysisOptions3d, EditorModel3d, StaticResult3d } from './types';

export type StaticAnalysis3d =
  | { kind: 'stable'; mesh: AnalysisMesh3d; result: StaticResult3d }
  | { kind: 'mechanism'; freeDofIndex: number; nodeId: number; message: string }
  | { kind: 'invalid'; message: string };

export type StaticSystem3d =
  | { ndof: number; K: SkylineMatrix; factor: SkylineFactor; freePerm: Int32Array }
  | { ndof: number; K: SkylineMatrix; mechanismFreeDof: number; freePerm: Int32Array };

/** Assemble and factor once (skyline free partition + RCM). */
export function prepareStaticSystem3d(mesh: AnalysisMesh3d): StaticSystem3d {
  const K = assembleK3d(mesh);
  const groups = mesh.elements.map((element) => {
    const a = 6 * element.na;
    const b = 6 * element.nb;
    return [a, a + 1, a + 2, a + 3, a + 4, a + 5, b, b + 1, b + 2, b + 3, b + 4, b + 5];
  });
  const { Kff, perm } = freeSkyline(K, mesh.freeDofs, groups);
  const result = factorSkylineLDLT(Kff);
  return result.ok
    ? { ndof: mesh.ndof, K, factor: result.factor, freePerm: perm }
    : { ndof: mesh.ndof, K, mechanismFreeDof: result.mechanism.freeDofIndex, freePerm: perm };
}

/** Solve one 3D static load case. */
export function solveStatic3d(
  mesh: AnalysisMesh3d,
  F: Float64Array,
  cachedSystem?: StaticSystem3d,
  elementFixedEnd?: Float64Array,
): StaticAnalysis3d {
  const system = cachedSystem ?? prepareStaticSystem3d(mesh);
  if (system.ndof !== mesh.ndof) return { kind: 'invalid', message: 'Static system does not match this analysis mesh.' };
  if ('mechanismFreeDof' in system) {
    const nodeId = mechanismEditorNode3d(mesh, system.mechanismFreeDof, system.freePerm);
    return {
      kind: 'mechanism',
      freeDofIndex: system.mechanismFreeDof,
      nodeId,
      message: `Node ${nodeId} can move freely — add a support or member.`,
    };
  }
  const Ff = freeVector(F, mesh.freeDofs);
  const n = Ff.length;
  const Fr = new Float64Array(n);
  for (let i = 0; i < n; i++) Fr[i] = Ff[system.freePerm[i]!]!;
  const ur = solveSkylineFactored(system.factor, Fr);
  const uf = new Float64Array(n);
  for (let i = 0; i < n; i++) uf[system.freePerm[i]!] = ur[i]!;
  const u = expandFreeVector(mesh.ndof, mesh.freeDofs, uf);
  const elementForces = recoverElementForces3d(mesh, u, elementFixedEnd);
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

/** Recover local end forces; subtract Hermite fixed-ends when present (traffic). */
export function elementForcesAtDisplacement3d(
  mesh: AnalysisMesh3d,
  u: Float64Array,
  elementFixedEnd?: Float64Array,
): Float64Array {
  return recoverElementForces3d(mesh, u, elementFixedEnd);
}

export function utilizationAtDisplacement3d(
  mesh: AnalysisMesh3d,
  u: Float64Array,
  elementFixedEnd?: Float64Array,
): Map<number, number> {
  return recoverUtilization3d(mesh, recoverElementForces3d(mesh, u, elementFixedEnd));
}

/**
 * Build mesh + solve the model's nodal load case (optional gravity −Z).
 * `options.shearFlexible` selects the Timoshenko element block.
 */
export function analyzeStaticModel3d(model: EditorModel3d, options: AnalysisOptions3d = {}): StaticAnalysis3d {
  try {
    const mesh = buildMesh3d(model, options);
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
    const loads = assembleLoadCase3d(mesh, { gravity: model.loads.gravity, points });
    return solveStatic3d(mesh, loads.F, undefined, loads.elementFixedEnd);
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : '3D static analysis could not run.' };
  }
}

function recoverElementForces3d(
  mesh: AnalysisMesh3d,
  u: Float64Array,
  elementFixedEnd?: Float64Array,
): Float64Array {
  const out = new Float64Array(mesh.elements.length * 12);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const k = elementLocalStiffness3d(element, mesh.shearFlexible === true);
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
      const fixed = elementFixedEnd?.[index * 12 + i] ?? 0;
      out[index * 12 + i] = force - fixed;
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
  K: SkylineMatrix,
  u: Float64Array,
  F: Float64Array,
): Map<number, { fx: number; fy: number; fz: number; mx: number; my: number; mz: number }> {
  const Ku = matvecSkyline(K, u);
  const reactions = new Map<number, { fx: number; fy: number; fz: number; mx: number; my: number; mz: number }>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const editorId = mesh.editorNode[node]!;
    if (editorId < 0) continue;
    const base = 6 * node;
    const r = {
      fx: Ku[base]! - F[base]!,
      fy: Ku[base + 1]! - F[base + 1]!,
      fz: Ku[base + 2]! - F[base + 2]!,
      mx: Ku[base + 3]! - F[base + 3]!,
      my: Ku[base + 4]! - F[base + 4]!,
      mz: Ku[base + 5]! - F[base + 5]!,
    };
    if (
      Math.abs(r.fx) > 1e-14 ||
      Math.abs(r.fy) > 1e-14 ||
      Math.abs(r.fz) > 1e-14 ||
      Math.abs(r.mx) > 1e-14 ||
      Math.abs(r.my) > 1e-14 ||
      Math.abs(r.mz) > 1e-14
    ) {
      reactions.set(editorId, r);
    }
  }
  return reactions;
}

/** Strain energy ½ uᵀ K u. Gate G24. */
export function strainEnergy3d(K: SkylineMatrix, u: Float64Array, _ndof?: number): number {
  const Ku = matvecSkyline(K, u);
  let energy = 0;
  for (let i = 0; i < u.length; i++) energy += u[i]! * Ku[i]!;
  return 0.5 * energy;
}

/** External work ½ uᵀ F at equilibrium. Gate G24. */
export function externalWork3d(u: Float64Array, F: Float64Array): number {
  let work = 0;
  for (let i = 0; i < u.length; i++) work += u[i]! * F[i]!;
  return 0.5 * work;
}

/** Map a singular free-partition pivot (RCM order) back to an editor node. */
export function mechanismEditorNode3d(mesh: AnalysisMesh3d, freeDofIndex: number, freePerm: Int32Array): number {
  const unordered = freePerm[freeDofIndex];
  if (unordered === undefined) return freeDofIndex;
  const fullDof = mesh.freeDofs[unordered];
  if (fullDof === undefined) return freeDofIndex;
  const meshNode = Math.floor(fullDof / 6);
  const direct = mesh.editorNode[meshNode];
  if (direct !== undefined && direct >= 0) return direct;
  for (const element of mesh.elements) {
    if (element.na === meshNode) {
      const id = mesh.editorNode[element.nb];
      if (id !== undefined && id >= 0) return id;
    }
    if (element.nb === meshNode) {
      const id = mesh.editorNode[element.na];
      if (id !== undefined && id >= 0) return id;
    }
  }
  return freeDofIndex;
}
