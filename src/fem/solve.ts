/**
 * Dense LDLᵀ factorization + solve on the free-DOF partition, with mechanism
 * detection via pivot magnitude. M1.
 */

export interface Factor {
  n: number;
  /** packed L (unit diagonal) and D */
  ld: Float64Array;
  d: Float64Array;
}

export type FactorResult =
  | { ok: true; factor: Factor }
  | { ok: false; mechanism: { freeDofIndex: number } };

/** Factor K_ff. Pivot ≤ 1e-10·max(diag) ⇒ mechanism at that DOF. */
export function factorLDLT(_kff: Float64Array, _n: number): FactorResult {
  throw new Error('TODO(M1): LDLᵀ with mechanism detection');
}

/** One forward/back substitution — this is the 60 fps traffic path. */
export function solveFactored(_f: Factor, _rhs: Float64Array): Float64Array {
  throw new Error('TODO(M1): substitution');
}
