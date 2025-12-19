/**
 * Failure taxonomy evaluation (mechanism / yield / buckling / resonance),
 * exact load-ramp capacity (linearity ⇒ λ_yield = 1/max U), and the
 * quasi-static collapse cascade. M6.
 */
import type { AnalysisMesh, CascadeResult, EditorModel, FailureReport } from './types';

export function evaluateFailure(_mesh: AnalysisMesh, _loadFactor: number): FailureReport {
  throw new Error('TODO(M6): taxonomy');
}

export function collapseCascade(_model: EditorModel): CascadeResult {
  throw new Error('TODO(M6): deterministic cascade (max 20 steps)');
}
