import type { AnalysisMesh } from './types';

/**
 * Dense LDLᵀ factorization + solve on the free-DOF partition, with mechanism
 * detection via pivot magnitude. docs/FEM-SPEC.md §4.3. M1.
 */

export interface Factor {
  n: number;
  /** dense lower-triangular L (unit diagonal) and D */
  ld: Float64Array;
  d: Float64Array;
}

export type FactorResult =
  | { ok: true; factor: Factor }
  | { ok: false; mechanism: { freeDofIndex: number } };

/**
 * Factor an SPD free-DOF stiffness matrix without pivoting.
 * docs/FEM-SPEC.md §4.3: a pivot at or below 1e-10 of max diagonal is a mechanism.
 */
export function factorLDLT(kff: Float64Array, n: number): FactorResult {
  if (!Number.isInteger(n) || n < 0 || kff.length !== n * n) {
    throw new Error('LDLᵀ input must be an n×n matrix.');
  }
  const ld = new Float64Array(n * n);
  const d = new Float64Array(n);
  let maxDiagonal = 0;
  for (let i = 0; i < n; i++) maxDiagonal = Math.max(maxDiagonal, Math.abs(kff[i * n + i]!));
  const mechanismTolerance = 1e-10 * maxDiagonal;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      let value = kff[i * n + j]!;
      for (let k = 0; k < j; k++) value -= ld[i * n + k]! * d[k]! * ld[j * n + k]!;
      ld[i * n + j] = value / d[j]!;
    }

    let pivot = kff[i * n + i]!;
    for (let k = 0; k < i; k++) pivot -= ld[i * n + k]! * ld[i * n + k]! * d[k]!;
    if (!Number.isFinite(pivot) || pivot <= mechanismTolerance) {
      return { ok: false, mechanism: { freeDofIndex: i } };
    }
    ld[i * n + i] = 1;
    d[i] = pivot;
  }

  return { ok: true, factor: { n, ld, d } };
}

/** One forward/back substitution — this is the 60 fps traffic path. docs/FEM-SPEC.md §4.3. */
export function solveFactored(factor: Factor, rhs: Float64Array): Float64Array {
  const { n, ld, d } = factor;
  if (rhs.length !== n) throw new Error('LDLᵀ right-hand side length does not match the factor.');
  const forward = new Float64Array(n);
  const diagonalSolved = new Float64Array(n);
  const solution = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let value = rhs[i]!;
    for (let j = 0; j < i; j++) value -= ld[i * n + j]! * forward[j]!;
    forward[i] = value;
    diagonalSolved[i] = value / d[i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let value = diagonalSolved[i]!;
    for (let j = i + 1; j < n; j++) value -= ld[j * n + i]! * solution[j]!;
    solution[i] = value;
  }
  return solution;
}

/** Extract K_ff from a full dense global matrix. docs/FEM-SPEC.md §4.3 constraints. */
export function freeMatrix(K: Float64Array, ndof: number, freeDofs: Int32Array): Float64Array {
  if (K.length !== ndof * ndof) throw new Error('Global matrix must be ndof×ndof.');
  const n = freeDofs.length;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const row = freeDofs[i]!;
    for (let j = 0; j < n; j++) out[i * n + j] = K[row * ndof + freeDofs[j]!]!;
  }
  return out;
}

/** Extract F_f from a full global load vector. docs/FEM-SPEC.md §4.3 constraints. */
export function freeVector(F: Float64Array, freeDofs: Int32Array): Float64Array {
  const out = new Float64Array(freeDofs.length);
  for (let i = 0; i < freeDofs.length; i++) out[i] = F[freeDofs[i]!]!;
  return out;
}

/** Expand a free-DOF solution into the full vector; constrained entries remain zero. */
export function expandFreeVector(
  ndof: number,
  freeDofs: Int32Array,
  freeValues: Float64Array,
): Float64Array {
  if (freeDofs.length !== freeValues.length)
    throw new Error('Free solution length does not match free DOFs.');
  const out = new Float64Array(ndof);
  for (let i = 0; i < freeDofs.length; i++) out[freeDofs[i]!] = freeValues[i]!;
  return out;
}

/**
 * Map an LDLᵀ pivot back to an editor node for the stability lint.
 * A frame midpoint is hidden implementation detail, so prefer a connected
 * physical node whose matching component is also unconstrained.
 * docs/FEM-SPEC.md §4.3 and §6.2.
 */
export function mechanismEditorNode(mesh: AnalysisMesh, freeDofIndex: number): number {
  const fullDof = mesh.freeDofs[freeDofIndex];
  if (fullDof === undefined) throw new Error(`Free DOF index ${freeDofIndex} is out of range.`);
  const meshNode = Math.floor(fullDof / 3);
  const direct = mesh.editorNode[meshNode];
  if (direct === undefined) throw new Error(`Mesh node ${meshNode} is out of range.`);
  if (direct >= 0) return direct;

  const component = fullDof % 3;
  const free = new Set(mesh.freeDofs);
  const candidates: number[] = [];
  for (const element of mesh.elements) {
    let adjacent: number | undefined;
    if (element.na === meshNode) adjacent = element.nb;
    if (element.nb === meshNode) adjacent = element.na;
    if (adjacent === undefined) continue;
    const editorId = mesh.editorNode[adjacent];
    if (editorId !== undefined && editorId >= 0 && free.has(3 * adjacent + component))
      candidates.push(adjacent);
  }

  // A rotational pivot can be adjacent to a supported pin (its rotation is
  // intentionally free) and to a genuinely free physical node. Prefer the
  // latter by counting unconstrained translations.
  candidates.sort((left, right) => {
    const translationalFreedom = (node: number) =>
      Number(free.has(3 * node)) + Number(free.has(3 * node + 1));
    return translationalFreedom(right) - translationalFreedom(left);
  });
  const best = candidates[0];
  if (best !== undefined) return mesh.editorNode[best]!;

  // This can only occur for a malformed mesh with no physical neighbour.
  return -1;
}
