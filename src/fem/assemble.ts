/**
 * Element matrices, transforms, assembly, load vectors.
 * The three element matrices below are implemented and tested now (scaffold anchor);
 * assembly and load vectors are M1 work.
 *
 * Local DOF order: [u1, v1, th1, u2, v2, th2]. Tension-positive N, CCW-positive rotation.
 */
import type { AnalysisMesh } from './types';

/** Euler–Bernoulli frame element stiffness, local axes. */
export function kLocal(E: number, A: number, I: number, L: number): Float64Array {
  const k = new Float64Array(36);
  const a = (E * A) / L;
  const b = (E * I) / (L * L * L);
  const set = (i: number, j: number, v: number) => {
    k[i * 6 + j] = v;
    k[j * 6 + i] = v;
  };
  set(0, 0, a);
  set(3, 3, a);
  set(0, 3, -a);
  set(1, 1, 12 * b);
  set(4, 4, 12 * b);
  set(1, 4, -12 * b);
  set(1, 2, 6 * b * L);
  set(1, 5, 6 * b * L);
  set(2, 4, -6 * b * L);
  set(4, 5, -6 * b * L);
  set(2, 2, 4 * b * L * L);
  set(5, 5, 4 * b * L * L);
  set(2, 5, 2 * b * L * L);
  return k;
}

/** Consistent geometric stiffness (transverse/rotation block), N tension-positive. */
export function kgLocal(N: number, L: number): Float64Array {
  const g = new Float64Array(36);
  const c = N / L;
  const idx = [1, 2, 4, 5];
  const m = [
    [6 / 5, L / 10, -6 / 5, L / 10],
    [L / 10, (2 * L * L) / 15, -L / 10, (-L * L) / 30],
    [-6 / 5, -L / 10, 6 / 5, -L / 10],
    [L / 10, (-L * L) / 30, -L / 10, (2 * L * L) / 15],
  ];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) g[idx[i]! * 6 + idx[j]!] = c * m[i]![j]!;
  return g;
}

/** Consistent mass matrix, local axes. */
export function mLocal(rho: number, A: number, L: number): Float64Array {
  const m = new Float64Array(36);
  const ax = (rho * A * L) / 6;
  m[0 * 6 + 0] = 2 * ax;
  m[3 * 6 + 3] = 2 * ax;
  m[0 * 6 + 3] = ax;
  m[3 * 6 + 0] = ax;
  const c = (rho * A * L) / 420;
  const b = [
    [156, 22 * L, 54, -13 * L],
    [22 * L, 4 * L * L, 13 * L, -3 * L * L],
    [54, 13 * L, 156, -22 * L],
    [-13 * L, -3 * L * L, -22 * L, 4 * L * L],
  ];
  const idx = [1, 2, 4, 5];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) m[idx[i]! * 6 + idx[j]!] = c * b[i]![j]!;
  return m;
}

/** K_global = Tᵀ k T with per-node rotation blocks R = [[c,s,0],[-s,c,0],[0,0,1]]. */
export function transformToGlobal(kLoc: Float64Array, cos: number, sin: number): Float64Array {
  // T maps global -> local. Column transform then row transform, exploiting block structure.
  const out = new Float64Array(36);
  const t = new Float64Array(36);
  // t = kLoc * T
  for (let i = 0; i < 6; i++) {
    for (let blk = 0; blk < 2; blk++) {
      const o = blk * 3;
      const a = kLoc[i * 6 + o]!;
      const b = kLoc[i * 6 + o + 1]!;
      t[i * 6 + o] = a * cos - b * sin;
      t[i * 6 + o + 1] = a * sin + b * cos;
      t[i * 6 + o + 2] = kLoc[i * 6 + o + 2]!;
    }
  }
  // out = Tᵀ * t
  for (let j = 0; j < 6; j++) {
    for (let blk = 0; blk < 2; blk++) {
      const o = blk * 3;
      const a = t[o * 6 + j]!;
      const b = t[(o + 1) * 6 + j]!;
      out[o * 6 + j] = a * cos - b * sin;
      out[(o + 1) * 6 + j] = a * sin + b * cos;
      out[(o + 2) * 6 + j] = t[(o + 2) * 6 + j]!;
    }
  }
  return out;
}

/** Assemble global K (dense, row-major ndof×ndof). M1. */
export function assembleK(_mesh: AnalysisMesh): Float64Array {
  throw new Error('TODO(M1): assemble with end-release condensation');
}

/** Assemble global M. M4. */
export function assembleM(_mesh: AnalysisMesh): Float64Array {
  throw new Error('TODO(M4): assemble consistent mass');
}

/** Assemble K_g from element axial forces. M4. */
export function assembleKg(_mesh: AnalysisMesh, _elementN: Float64Array): Float64Array {
  throw new Error('TODO(M4): assemble geometric stiffness');
}

/** Global load vector: nodal + self-weight UDL + in-element point loads (Hermite). M1. */
export function assembleF(
  _mesh: AnalysisMesh,
  _opts: {
    gravity: boolean;
    points: { meshNode: number; fx: number; fy: number }[];
    /** traffic axles: element index + position ξ∈[0,1] + force (global -y) */
    inElement?: { element: number; xi: number; p: number }[];
  },
): Float64Array {
  throw new Error('TODO(M1): consistent load vectors');
}
