/**
 * Subspace iteration for the two generalized symmetric eigenproblems:
 *   modal    K φ = ω² M φ
 *   buckling K φ = μ (−K_g) φ,  λ_cr = 1 / max(μ > 0)
 * Jacobi eigensolver on the p×p Ritz block. docs/FEM-SPEC.md §4.5. M4 (runs in worker).
 *
 * Measured accuracy at 2 sub-elements/member: buckling +0.75%, ω₁ +0.39% (gates G3, G4).
 */
import { assembleK, assembleKg, assembleM } from './assemble';
import { factorLDLT, freeMatrix, solveFactored } from './solve';
import type { AnalysisMesh, EigenResult } from './types';

const MAX_ITERATIONS = 80;
const RELATIVE_TOLERANCE = 1e-8;
const MAX_REQUESTED_MODES = 8;

/** Solve Kφ = ω²Mφ for the requested lowest natural frequencies. docs/FEM-SPEC.md §4.5. */
export function modal(mesh: AnalysisMesh, nModes: number): EigenResult {
  return modalAssembled(mesh, assembleK(mesh), assembleM(mesh), nModes);
}

/**
 * Dimension-agnostic modal analysis from assembled global matrices.
 * Used by the 2D path and the Phase 3 space-frame path.
 */
export function modalAssembled(
  layout: EigenDofLayout,
  Kfull: Float64Array,
  Mfull: Float64Array,
  nModes: number,
): EigenResult {
  const prepared = prepareAssembled(layout, Kfull, nModes);
  const M = freeMatrix(Mfull, layout.ndof, layout.freeDofs);
  let basis = orthonormalizeMetric(
    initialBasis(prepared.n, prepared.p),
    M,
    prepared.n,
    prepared.p,
  ).basis;
  let previous = new Float64Array(0);
  let iterations = 0;
  let ritz: GeneralizedEigen | undefined;
  let ritzBasis: Float64Array | undefined;

  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    const rhs = matrixTimesColumns(M, prepared.n, basis, prepared.p);
    const inverseApplied = solveColumns(prepared.factor, rhs, prepared.n, prepared.p);
    const orthogonal = orthonormalizeMetric(inverseApplied, M, prepared.n, prepared.p);
    const Kbasis = matrixTimesColumns(prepared.K, prepared.n, orthogonal.basis, prepared.p);
    const Kstar = project(orthogonal.basis, Kbasis, prepared.n, prepared.p);
    const Mstar = project(orthogonal.basis, orthogonal.metricBasis, prepared.n, prepared.p);
    ritz = generalizedSymmetric(Kstar, Mstar, prepared.p);
    ritzBasis = rotateColumns(orthogonal.basis, ritz.vectors, prepared.n, prepared.p);
    const wanted = ritz.values.slice(0, prepared.modes);
    if (hasConverged(previous, wanted)) break;
    previous = wanted;
    basis = ritzBasis;
  }

  if (!ritz || !ritzBasis) throw new Error('Modal subspace iteration did not initialize.');
  const values = new Float64Array(prepared.modes);
  for (let index = 0; index < prepared.modes; index++) {
    const value = ritz.values[index]!;
    if (!(value > 0) || !Number.isFinite(value))
      throw new Error('Modal analysis produced a non-positive eigenvalue.');
    values[index] = Math.sqrt(value);
  }
  return {
    kind: 'modal',
    values,
    vectors: expandModeVectors(
      layout,
      ritzBasis,
      prepared.n,
      prepared.p,
      range(prepared.modes),
      M,
      true,
    ),
    iterations,
  };
}

/**
 * Solve Kφ = μ(−K_g)φ and return λ_cr = 1/μ for the positive buckling roots.
 * Element axial forces are tension-positive, so compression makes K_g negative.
 * docs/FEM-SPEC.md §4.1 and §4.5.
 */
export function buckling(mesh: AnalysisMesh, elementN: Float64Array): EigenResult {
  return bucklingAssembled(mesh, assembleK(mesh), assembleKg(mesh, elementN));
}

/**
 * Dimension-agnostic buckling from assembled global matrices.
 * Used by the 2D path and the Phase 3 space-frame path.
 */
export function bucklingAssembled(
  layout: EigenDofLayout,
  Kfull: Float64Array,
  Kgfull: Float64Array,
): EigenResult {
  const prepared = prepareAssembled(layout, Kfull, MAX_REQUESTED_MODES);
  const kg = freeMatrix(Kgfull, layout.ndof, layout.freeDofs);
  const B = new Float64Array(kg.length);
  for (let index = 0; index < kg.length; index++) B[index] = -kg[index]!;

  let basis = orthonormalizeMetric(
    initialBasis(prepared.n, prepared.p),
    prepared.K,
    prepared.n,
    prepared.p,
  ).basis;
  let previous = new Float64Array(0);
  let iterations = 0;
  let ritz: GeneralizedEigen | undefined;
  let ritzBasis: Float64Array | undefined;

  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    const rhs = matrixTimesColumns(B, prepared.n, basis, prepared.p);
    const inverseApplied = solveColumns(prepared.factor, rhs, prepared.n, prepared.p);
    const orthogonal = orthonormalizeMetric(inverseApplied, prepared.K, prepared.n, prepared.p);
    const Bbasis = matrixTimesColumns(B, prepared.n, orthogonal.basis, prepared.p);
    const Bstar = project(orthogonal.basis, Bbasis, prepared.n, prepared.p);
    const Kstar = project(orthogonal.basis, orthogonal.metricBasis, prepared.n, prepared.p);
    const raw = generalizedSymmetric(Bstar, Kstar, prepared.p);
    const order = orderByMagnitude(raw.values);
    ritz = reorderEigen(raw, order);
    ritzBasis = rotateColumns(orthogonal.basis, ritz.vectors, prepared.n, prepared.p);
    const positive = positiveBucklingRoots(ritz.values, prepared.modes);
    if (hasConverged(previous, positive.values)) break;
    previous = new Float64Array(positive.values);
    basis = ritzBasis;
  }

  if (!ritz || !ritzBasis) throw new Error('Buckling subspace iteration did not initialize.');
  const positive = positiveBucklingRoots(ritz.values, prepared.modes);
  const factors = new Float64Array(positive.values.length);
  for (let index = 0; index < factors.length; index++) factors[index] = 1 / positive.values[index]!;
  return {
    kind: 'buckling',
    values: factors,
    vectors: expandModeVectors(
      layout,
      ritzBasis,
      prepared.n,
      prepared.p,
      positive.indices,
      undefined,
      false,
    ),
    iterations,
  };
}

/** DOF layout shared by 2D and 3D eigen paths. */
export interface EigenDofLayout {
  ndof: number;
  freeDofs: Int32Array;
}

interface PreparedProblem {
  K: Float64Array;
  factor: ReturnType<typeof factorLDLT> & { ok: true };
  n: number;
  p: number;
  modes: number;
}

function prepareAssembled(
  layout: EigenDofLayout,
  Kfull: Float64Array,
  requestedModes: number,
): PreparedProblem {
  if (!Number.isInteger(requestedModes) || requestedModes < 1)
    throw new Error('Eigenanalysis needs at least one mode.');
  const n = layout.freeDofs.length;
  if (n === 0) throw new Error('Eigenanalysis needs at least one unconstrained degree of freedom.');
  const K = freeMatrix(Kfull, layout.ndof, layout.freeDofs);
  const factor = factorLDLT(K, n);
  if (!factor.ok)
    throw new Error(
      `Eigenanalysis cannot run: mechanism at free DOF ${factor.mechanism.freeDofIndex}.`,
    );
  const modes = Math.min(requestedModes, n);
  const p = Math.min(n, Math.max(modes, Math.min(14, modes + 6)));
  return { K, factor, n, p, modes };
}

interface OrthonormalBasis {
  basis: Float64Array;
  metricBasis: Float64Array;
}

/** Modified Gram–Schmidt in the M (or K) inner product. docs/FEM-SPEC.md §4.5. */
function orthonormalizeMetric(
  input: Float64Array,
  metric: Float64Array,
  n: number,
  columns: number,
): OrthonormalBasis {
  const basis = new Float64Array(n * columns);
  const metricBasis = new Float64Array(n * columns);
  for (let column = 0; column < columns; column++) {
    let vector = columnSlice(input, n, columns, column);
    let metricVector = multiplyMatrixVector(metric, n, vector);
    let squaredNorm = removeMetricComponents(
      vector,
      metricVector,
      basis,
      metricBasis,
      n,
      columns,
      column,
    );
    // K_g has zero axial rows, so buckling iteration can legitimately lose a
    // direction. Retain a deterministic complementary direction for the Ritz
    // space instead of treating that physical zero root as an algorithm error.
    for (let candidate = 0; !(squaredNorm > 1e-20) && candidate < n; candidate++) {
      vector = new Float64Array(n);
      vector[(column + candidate) % n] = 1;
      metricVector = multiplyMatrixVector(metric, n, vector);
      squaredNorm = removeMetricComponents(
        vector,
        metricVector,
        basis,
        metricBasis,
        n,
        columns,
        column,
      );
    }
    if (!(squaredNorm > 1e-20) || !Number.isFinite(squaredNorm)) {
      throw new Error('Eigenanalysis basis lost rank; revise the structural model.');
    }
    const inverseNorm = 1 / Math.sqrt(squaredNorm);
    for (let row = 0; row < n; row++) {
      basis[row * columns + column] = vector[row]! * inverseNorm;
      metricBasis[row * columns + column] = metricVector[row]! * inverseNorm;
    }
  }
  return { basis, metricBasis };
}

function removeMetricComponents(
  vector: Float64Array,
  metricVector: Float64Array,
  basis: Float64Array,
  metricBasis: Float64Array,
  n: number,
  columns: number,
  count: number,
): number {
  for (let previous = 0; previous < count; previous++) {
    const q = columnSlice(basis, n, columns, previous);
    const metricQ = columnSlice(metricBasis, n, columns, previous);
    const coefficient = dot(q, metricVector);
    for (let row = 0; row < n; row++) {
      vector[row] = vector[row]! - coefficient * q[row]!;
      metricVector[row] = metricVector[row]! - coefficient * metricQ[row]!;
    }
  }
  return dot(vector, metricVector);
}

function initialBasis(n: number, columns: number): Float64Array {
  const out = new Float64Array(n * columns);
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < columns; column++) {
      out[row * columns + column] =
        Math.sin((row + 1) * (column + 1) * 0.719) + Math.cos((row + 2) * (column + 1) * 0.311);
    }
  }
  return out;
}

function solveColumns(
  factor: ReturnType<typeof factorLDLT> & { ok: true },
  rhs: Float64Array,
  n: number,
  columns: number,
): Float64Array {
  const out = new Float64Array(n * columns);
  for (let column = 0; column < columns; column++) {
    const solved = solveFactored(factor.factor, columnSlice(rhs, n, columns, column));
    for (let row = 0; row < n; row++) out[row * columns + column] = solved[row]!;
  }
  return out;
}

function matrixTimesColumns(
  matrix: Float64Array,
  n: number,
  basis: Float64Array,
  columns: number,
): Float64Array {
  const out = new Float64Array(n * columns);
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < columns; column++) {
      let value = 0;
      for (let index = 0; index < n; index++)
        value += matrix[row * n + index]! * basis[index * columns + column]!;
      out[row * columns + column] = value;
    }
  }
  return out;
}

/** XᵀAX for a column-major-by-row basis encoded as [row * p + column]. */
function project(
  left: Float64Array,
  right: Float64Array,
  n: number,
  columns: number,
): Float64Array {
  const out = new Float64Array(columns * columns);
  for (let row = 0; row < columns; row++) {
    for (let column = 0; column < columns; column++) {
      let value = 0;
      for (let index = 0; index < n; index++)
        value += left[index * columns + row]! * right[index * columns + column]!;
      out[row * columns + column] = value;
    }
  }
  return out;
}

function rotateColumns(
  basis: Float64Array,
  coordinates: Float64Array,
  n: number,
  columns: number,
): Float64Array {
  const out = new Float64Array(n * columns);
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < columns; column++) {
      let value = 0;
      for (let index = 0; index < columns; index++)
        value += basis[row * columns + index]! * coordinates[index * columns + column]!;
      out[row * columns + column] = value;
    }
  }
  return out;
}

interface GeneralizedEigen {
  values: Float64Array;
  /** vectors are column-major-by-row: [coordinate row * n + mode column]. */
  vectors: Float64Array;
}

/** Cholesky-reduce a small symmetric generalized Ritz problem, then Jacobi-solve it. docs/FEM-SPEC.md §4.5. */
function generalizedSymmetric(K: Float64Array, M: Float64Array, n: number): GeneralizedEigen {
  const L = cholesky(M, n);
  const invL = invertLower(L, n);
  const reduced = multiplySquare(multiplySquare(invL, K, n), transpose(invL, n), n);
  const standard = jacobiSymmetric(reduced, n);
  const coordinates = multiplySquare(transpose(invL, n), standard.vectors, n);
  return { values: standard.values, vectors: coordinates };
}

function cholesky(matrix: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row * n + column]!;
      for (let index = 0; index < column; index++)
        value -= L[row * n + index]! * L[column * n + index]!;
      if (row === column) {
        if (!(value > 1e-18) || !Number.isFinite(value))
          throw new Error('Eigenanalysis metric is not positive definite.');
        L[row * n + column] = Math.sqrt(value);
      } else {
        L[row * n + column] = value / L[column * n + column]!;
      }
    }
  }
  return L;
}

function invertLower(L: Float64Array, n: number): Float64Array {
  const inverse = new Float64Array(n * n);
  for (let column = 0; column < n; column++) {
    for (let row = 0; row < n; row++) {
      let value = row === column ? 1 : 0;
      for (let index = 0; index < row; index++)
        value -= L[row * n + index]! * inverse[index * n + column]!;
      inverse[row * n + column] = value / L[row * n + row]!;
    }
  }
  return inverse;
}

function jacobiSymmetric(input: Float64Array, n: number): GeneralizedEigen {
  const matrix = new Float64Array(input);
  const vectors = identity(n);
  const maxSteps = Math.max(30, 80 * n * n);
  for (let step = 0; step < maxSteps; step++) {
    let p = 0;
    let q = 0;
    let maximum = 0;
    for (let row = 0; row < n; row++) {
      for (let column = row + 1; column < n; column++) {
        const value = Math.abs(matrix[row * n + column]!);
        if (value > maximum) {
          maximum = value;
          p = row;
          q = column;
        }
      }
    }
    if (maximum < 1e-12) break;
    const app = matrix[p * n + p]!;
    const aqq = matrix[q * n + q]!;
    const apq = matrix[p * n + q]!;
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let index = 0; index < n; index++) {
      if (index === p || index === q) continue;
      const aip = matrix[index * n + p]!;
      const aiq = matrix[index * n + q]!;
      matrix[index * n + p] = c * aip - s * aiq;
      matrix[p * n + index] = matrix[index * n + p]!;
      matrix[index * n + q] = s * aip + c * aiq;
      matrix[q * n + index] = matrix[index * n + q]!;
    }
    matrix[p * n + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    matrix[q * n + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    matrix[p * n + q] = 0;
    matrix[q * n + p] = 0;
    for (let row = 0; row < n; row++) {
      const vip = vectors[row * n + p]!;
      const viq = vectors[row * n + q]!;
      vectors[row * n + p] = c * vip - s * viq;
      vectors[row * n + q] = s * vip + c * viq;
    }
  }
  const values = new Float64Array(n);
  for (let index = 0; index < n; index++) values[index] = matrix[index * n + index]!;
  return reorderEigen({ values, vectors }, orderAscending(values));
}

function expandModeVectors(
  layout: EigenDofLayout,
  basis: Float64Array,
  n: number,
  columns: number,
  indices: readonly number[],
  metric: Float64Array | undefined,
  massNormalize: boolean,
): Float64Array {
  const out = new Float64Array(layout.ndof * indices.length);
  for (let outputColumn = 0; outputColumn < indices.length; outputColumn++) {
    const inputColumn = indices[outputColumn]!;
    const vector = columnSlice(basis, n, columns, inputColumn);
    let scale = 1;
    if (massNormalize && metric) {
      const metricVector = multiplyMatrixVector(metric, n, vector);
      scale = 1 / Math.sqrt(dot(vector, metricVector));
    } else {
      let maximum = 0;
      for (const value of vector) maximum = Math.max(maximum, Math.abs(value));
      scale = maximum > 0 ? 1 / maximum : 1;
    }
    for (let row = 0; row < n; row++)
      out[layout.freeDofs[row]! * indices.length + outputColumn] = vector[row]! * scale;
  }
  return out;
}

function positiveBucklingRoots(
  values: Float64Array,
  maximum: number,
): { values: Float64Array; indices: number[] } {
  const indices: number[] = [];
  for (let index = 0; index < values.length && indices.length < maximum; index++) {
    if (values[index]! > 1e-12 && Number.isFinite(values[index]!)) indices.push(index);
  }
  return { values: Float64Array.from(indices.map((index) => values[index]!)), indices };
}

function hasConverged(previous: Float64Array, current: Float64Array): boolean {
  if (previous.length !== current.length || current.length === 0) return false;
  for (let index = 0; index < current.length; index++) {
    const denominator = Math.max(Math.abs(current[index]!), 1e-16);
    if (Math.abs(current[index]! - previous[index]!) / denominator >= RELATIVE_TOLERANCE)
      return false;
  }
  return true;
}

function reorderEigen(eigen: GeneralizedEigen, order: readonly number[]): GeneralizedEigen {
  const n = eigen.values.length;
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  for (let output = 0; output < n; output++) {
    const input = order[output]!;
    values[output] = eigen.values[input]!;
    for (let row = 0; row < n; row++) vectors[row * n + output] = eigen.vectors[row * n + input]!;
  }
  return { values, vectors };
}

function orderAscending(values: Float64Array): number[] {
  return range(values.length).sort((left, right) => values[left]! - values[right]!);
}

function orderByMagnitude(values: Float64Array): number[] {
  return range(values.length).sort(
    (left, right) => Math.abs(values[right]!) - Math.abs(values[left]!),
  );
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function identity(n: number): Float64Array {
  const out = new Float64Array(n * n);
  for (let index = 0; index < n; index++) out[index * n + index] = 1;
  return out;
}

function transpose(input: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n * n);
  for (let row = 0; row < n; row++)
    for (let column = 0; column < n; column++) out[column * n + row] = input[row * n + column]!;
  return out;
}

function multiplySquare(left: Float64Array, right: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      let value = 0;
      for (let index = 0; index < n; index++)
        value += left[row * n + index]! * right[index * n + column]!;
      out[row * n + column] = value;
    }
  }
  return out;
}

function multiplyMatrixVector(matrix: Float64Array, n: number, vector: Float64Array): Float64Array {
  const out = new Float64Array(n);
  for (let row = 0; row < n; row++) {
    let value = 0;
    for (let column = 0; column < n; column++) value += matrix[row * n + column]! * vector[column]!;
    out[row] = value;
  }
  return out;
}

function columnSlice(
  input: Float64Array,
  rows: number,
  columns: number,
  column: number,
): Float64Array {
  const out = new Float64Array(rows);
  for (let row = 0; row < rows; row++) out[row] = input[row * columns + column]!;
  return out;
}

function dot(left: Float64Array, right: Float64Array): number {
  let value = 0;
  for (let index = 0; index < left.length; index++) value += left[index]! * right[index]!;
  return value;
}
