/**
 * Newmark-β (γ=1/2, β=1/4) with Rayleigh damping; modal projection for the
 * explainer layer; DAF meter; resonance detection. M5.
 */
import type { AnalysisMesh } from './types';

export interface NewmarkState {
  u: Float64Array;
  v: Float64Array;
  a: Float64Array;
  t: number;
}

export interface RayleighParams {
  a: number; // mass-proportional
  b: number; // stiffness-proportional
}

/** a = 2ζω₁ω₂/(ω₁+ω₂), b = 2ζ/(ω₁+ω₂). Gate G9. */
export function rayleighFit(_zeta: number, _w1: number, _w2: number): RayleighParams {
  throw new Error('TODO(M5)');
}

export function newmarkStep(
  _mesh: AnalysisMesh,
  _state: NewmarkState,
  _loadAt: (t: number) => Float64Array,
  _dt: number,
): NewmarkState {
  throw new Error('TODO(M5): Newmark update (factor K̂ once per story)');
}
