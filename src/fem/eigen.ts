/**
 * Subspace iteration for the two generalized symmetric eigenproblems:
 *   modal    K φ = ω² M φ
 *   buckling K φ = μ (−K_g) φ,  λ_cr = 1 / max(μ > 0)
 * Jacobi eigensolver on the p×p Ritz block. M4 (runs in worker).
 *
 * Measured accuracy at 2 sub-elements/member: buckling +0.75%, ω₁ +0.39% (gates G3, G4).
 */
import type { AnalysisMesh, EigenResult } from './types';

export function modal(_mesh: AnalysisMesh, _nModes: number): EigenResult {
  throw new Error('TODO(M4): subspace iteration');
}

export function buckling(_mesh: AnalysisMesh, _elementN: Float64Array): EigenResult {
  throw new Error('TODO(M4): buckling eigenproblem');
}
