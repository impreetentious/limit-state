/**
 * Symmetric skyline (profile) storage + LDLᵀ — docs/FEM-SPEC.md §4.3 / §4.9 / §14 3S.
 * Packed lower triangle: row i holds columns firstCol[i]…i inclusive.
 * Pure Float64Array; no DOM. Used by the 3D static path; 2D stays dense.
 */

export interface SkylineMatrix {
  n: number;
  /** First column index of row i (0 ≤ firstCol[i] ≤ i). */
  firstCol: Int32Array;
  /** Index of the diagonal entry of row i inside `values`. */
  diagIndex: Int32Array;
  /** Packed lower-triangle values (including diagonals). */
  values: Float64Array;
}

export interface SkylineFactor {
  n: number;
  firstCol: Int32Array;
  diagIndex: Int32Array;
  /** Unit-diagonal L below diagonal (same packing as SkylineMatrix). */
  ld: Float64Array;
  d: Float64Array;
}

export type SkylineFactorResult =
  | { ok: true; factor: SkylineFactor }
  | { ok: false; mechanism: { freeDofIndex: number } };

/** Build a zero skyline from a first-column profile. */
export function createSkyline(firstCol: Int32Array): SkylineMatrix {
  const n = firstCol.length;
  const diagIndex = new Int32Array(n);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const first = firstCol[i]!;
    if (!(first >= 0 && first <= i)) throw new Error(`Invalid skyline profile at row ${i}.`);
    diagIndex[i] = cursor + (i - first);
    cursor += i - first + 1;
  }
  return { n, firstCol: Int32Array.from(firstCol), diagIndex, values: new Float64Array(cursor) };
}

/**
 * Profile from element DOF lists: firstCol[i] = min connected DOF ≤ i (self inclusive).
 */
export function profileFromDofGroups(
  ndof: number,
  groups: ReadonlyArray<ReadonlyArray<number>>,
): Int32Array {
  const firstCol = new Int32Array(ndof);
  for (let i = 0; i < ndof; i++) firstCol[i] = i;
  for (const group of groups) {
    if (group.length === 0) continue;
    let minDof = group[0]!;
    for (const dof of group) {
      if (dof < 0 || dof >= ndof) throw new Error(`Profile DOF ${dof} out of range.`);
      if (dof < minDof) minDof = dof;
    }
    for (const dof of group) {
      if (minDof < firstCol[dof]!) firstCol[dof] = minDof;
    }
  }
  return firstCol;
}

/** Index of K[i,j] in packed storage, or -1 if outside the envelope (value is 0). Assumes i ≥ j. */
export function skylineIndex(K: SkylineMatrix, i: number, j: number): number {
  if (j < K.firstCol[i]!) return -1;
  return K.diagIndex[i]! - (i - j);
}

/** Add v into K[i,j] and K[j,i] (symmetric). No-op outside envelope is an error if v ≠ 0. */
export function skylineAdd(K: SkylineMatrix, i: number, j: number, v: number): void {
  if (!(v !== 0 && Number.isFinite(v))) {
    if (v === 0) return;
    throw new Error('Skyline add requires a finite value.');
  }
  const row = i >= j ? i : j;
  const col = i >= j ? j : i;
  const index = skylineIndex(K, row, col);
  if (index < 0) throw new Error(`Skyline envelope missing entry (${row},${col}).`);
  K.values[index] = K.values[index]! + v;
}

export function skylineGet(K: SkylineMatrix, i: number, j: number): number {
  const row = i >= j ? i : j;
  const col = i >= j ? j : i;
  const index = skylineIndex(K, row, col);
  return index < 0 ? 0 : K.values[index]!;
}

/** Dense row-major copy (tests / eigen bridge). */
export function skylineToDense(K: SkylineMatrix): Float64Array {
  const { n } = K;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = K.firstCol[i]!; j <= i; j++) {
      const v = K.values[skylineIndex(K, i, j)]!;
      out[i * n + j] = v;
      out[j * n + i] = v;
    }
  }
  return out;
}

/** y = K x for symmetric skyline. */
export function matvecSkyline(K: SkylineMatrix, x: Float64Array): Float64Array {
  if (x.length !== K.n) throw new Error('Skyline matvec length mismatch.');
  const y = new Float64Array(K.n);
  for (let i = 0; i < K.n; i++) {
    let sum = 0;
    for (let j = K.firstCol[i]!; j < i; j++) {
      const a = K.values[skylineIndex(K, i, j)]!;
      sum += a * x[j]!;
      y[j] = y[j]! + a * x[i]!;
    }
    sum += K.values[K.diagIndex[i]!]! * x[i]!;
    y[i] = y[i]! + sum;
  }
  return y;
}

/**
 * Extract the free-DOF principal submatrix as a skyline, renumbered by RCM.
 * Profile is built from free connectivity (not the full-matrix envelope).
 * Returns `perm` with perm[newIndex] = old free index (into freeDofs).
 */
export function freeSkyline(
  K: SkylineMatrix,
  freeDofs: Int32Array,
  groups?: ReadonlyArray<ReadonlyArray<number>>,
): { Kff: SkylineMatrix; perm: Int32Array } {
  const n = freeDofs.length;
  const identity = Int32Array.from({ length: n }, (_, i) => i);
  const perm = groups && groups.length > 0 ? rcmOrder(freeAdjacency(freeDofs, groups)) : identity;
  const inv = new Int32Array(n);
  for (let i = 0; i < n; i++) inv[perm[i]!] = i;

  let maxG = 0;
  for (let i = 0; i < n; i++) maxG = Math.max(maxG, freeDofs[i]!);
  const globalToOldFree = new Int32Array(maxG + 1).fill(-1);
  for (let i = 0; i < n; i++) globalToOldFree[freeDofs[i]!] = i;

  const firstCol = new Int32Array(n);
  for (let i = 0; i < n; i++) firstCol[i] = i;
  if (groups) {
    for (const group of groups) {
      const locals: number[] = [];
      for (const g of group) {
        if (g >= 0 && g <= maxG && globalToOldFree[g]! >= 0) locals.push(inv[globalToOldFree[g]!]!);
      }
      if (locals.length === 0) continue;
      let minL = locals[0]!;
      for (const l of locals) if (l < minL) minL = l;
      for (const l of locals) if (minL < firstCol[l]!) firstCol[l] = minL;
    }
  } else {
    for (let newI = 0; newI < n; newI++) {
      const gi = freeDofs[perm[newI]!]!;
      for (let gj = 0; gj <= gi; gj++) {
        const oldJ = gj <= maxG ? globalToOldFree[gj]! : -1;
        if (oldJ < 0) continue;
        const newJ = inv[oldJ]!;
        if (newJ <= newI && newJ < firstCol[newI]!) firstCol[newI] = newJ;
      }
    }
  }

  const out = createSkyline(firstCol);
  for (let newI = 0; newI < n; newI++) {
    const gi = freeDofs[perm[newI]!]!;
    for (let newJ = out.firstCol[newI]!; newJ <= newI; newJ++) {
      const gj = freeDofs[perm[newJ]!]!;
      const v = skylineGet(K, gi, gj);
      if (v !== 0) out.values[skylineIndex(out, newI, newJ)] = v;
    }
  }
  return { Kff: out, perm };
}

/**
 * In-place skyline LDLᵀ (no pivoting). Mechanism if D_ii ≤ ε · max|diag(K)|.
 */
export function factorSkylineLDLT(K: SkylineMatrix): SkylineFactorResult {
  const { n, firstCol, diagIndex } = K;
  const ld = Float64Array.from(K.values);
  const d = new Float64Array(n);
  let maxDiagonal = 0;
  for (let i = 0; i < n; i++)
    maxDiagonal = Math.max(maxDiagonal, Math.abs(K.values[diagIndex[i]!]!));
  const mechanismTolerance = 1e-10 * maxDiagonal;

  const get = (row: number, col: number): number => {
    if (col < firstCol[row]!) return 0;
    return ld[diagIndex[row]! - (row - col)]!;
  };
  const set = (row: number, col: number, value: number): void => {
    ld[diagIndex[row]! - (row - col)] = value;
  };

  for (let i = 0; i < n; i++) {
    for (let j = firstCol[i]!; j < i; j++) {
      let value = get(i, j);
      const k0 = Math.max(firstCol[i]!, firstCol[j]!);
      for (let k = k0; k < j; k++) value -= get(i, k) * d[k]! * get(j, k);
      if (!(Math.abs(d[j]!) > 0)) return { ok: false, mechanism: { freeDofIndex: j } };
      set(i, j, value / d[j]!);
    }
    let pivot = get(i, i);
    for (let k = firstCol[i]!; k < i; k++) {
      const lik = get(i, k);
      pivot -= lik * lik * d[k]!;
    }
    if (!Number.isFinite(pivot) || pivot <= mechanismTolerance) {
      return { ok: false, mechanism: { freeDofIndex: i } };
    }
    d[i] = pivot;
    set(i, i, 1);
  }

  return {
    ok: true,
    factor: {
      n,
      firstCol: Int32Array.from(firstCol),
      diagIndex: Int32Array.from(diagIndex),
      ld,
      d,
    },
  };
}

/** Forward / diagonal / back substitution on a skyline factor. */
export function solveSkylineFactored(factor: SkylineFactor, rhs: Float64Array): Float64Array {
  const { n, firstCol, diagIndex, ld, d } = factor;
  if (rhs.length !== n) throw new Error('Skyline RHS length does not match the factor.');
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const x = new Float64Array(n);

  const L = (row: number, col: number): number => ld[diagIndex[row]! - (row - col)]!;

  for (let i = 0; i < n; i++) {
    let value = rhs[i]!;
    for (let j = firstCol[i]!; j < i; j++) value -= L(i, j) * y[j]!;
    y[i] = value;
    z[i] = value / d[i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let value = z[i]!;
    for (let row = i + 1; row < n; row++) {
      if (i < firstCol[row]!) continue;
      value -= L(row, i) * x[row]!;
    }
    x[i] = value;
  }
  return x;
}

/**
 * Reverse Cuthill–McKee ordering for free-DOF indices (0..n-1).
 * Returns `perm` where perm[newIndex] = oldIndex.
 */
export function rcmOrder(adjacency: ReadonlyArray<ReadonlyArray<number>>): Int32Array {
  const n = adjacency.length;
  const perm = new Int32Array(n);
  if (n === 0) return perm;
  const degree = adjacency.map((nbrs) => nbrs.length);
  const visited = new Uint8Array(n);

  const components: number[] = [];
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    // Pick a peripheral-ish start: minimum degree in this unseen component.
    let seed = start;
    for (let i = start; i < n; i++) {
      if (!visited[i] && degree[i]! < degree[seed]!) seed = i;
    }
    const queue: number[] = [seed];
    visited[seed] = 1;
    const level: number[] = [];
    while (queue.length) {
      const node = queue.shift()!;
      level.push(node);
      const nbrs = [...adjacency[node]!]
        .filter((j) => !visited[j])
        .sort((a, b) => degree[a]! - degree[b]!);
      for (const nbr of nbrs) {
        visited[nbr] = 1;
        queue.push(nbr);
      }
    }
    // Reverse Cuthill–McKee: reverse the level order.
    for (let i = level.length - 1; i >= 0; i--) components.push(level[i]!);
  }
  for (let i = 0; i < n; i++) perm[i] = components[i]!;
  return perm;
}

/** Build free-DOF adjacency (undirected) from element DOF groups. */
export function freeAdjacency(
  freeDofs: Int32Array,
  groups: ReadonlyArray<ReadonlyArray<number>>,
): number[][] {
  const n = freeDofs.length;
  let maxG = 0;
  for (let i = 0; i < n; i++) maxG = Math.max(maxG, freeDofs[i]!);
  const map = new Int32Array(maxG + 1).fill(-1);
  for (let i = 0; i < n; i++) map[freeDofs[i]!] = i;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const seen = Array.from({ length: n }, () => new Set<number>());
  for (const group of groups) {
    const locals: number[] = [];
    for (const g of group) {
      if (g >= 0 && g <= maxG && map[g]! >= 0) locals.push(map[g]!);
    }
    for (let i = 0; i < locals.length; i++) {
      for (let j = i + 1; j < locals.length; j++) {
        const a = locals[i]!;
        const b = locals[j]!;
        if (!seen[a]!.has(b)) {
          seen[a]!.add(b);
          seen[b]!.add(a);
          adj[a]!.push(b);
          adj[b]!.push(a);
        }
      }
    }
  }
  return adj;
}

/** Packed entry count (diagnostic / tests). */
export function skylineNnz(K: SkylineMatrix): number {
  return K.values.length;
}
