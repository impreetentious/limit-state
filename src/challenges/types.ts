/** Challenge catalog types. docs/FEM-SPEC.md §14 2G. */
import type { EditorModel } from '../fem/types';

/** Constrained-budget challenge definition. docs/FEM-SPEC.md §14 2G. */
export interface ChallengeSpec {
  id: string;
  label: string;
  /** One-line pedagogy for the challenge menu / gallery. */
  brief: string;
  constraints: ChallengeConstraints;
  starter: EditorModel;
}

/**
 * Budget and performance checks a submitted model must satisfy.
 * Steel mass always counts only `steel-s355` members. docs/FEM-SPEC.md §14 2G.
 */
export interface ChallengeConstraints {
  /** Maximum steel mass (kg). */
  maxSteelMassKg: number;
  /** Minimum clear horizontal span between outermost supports (m). */
  minClearSpanM?: number;
  /** Minimum structure height from lowest to highest node (m). */
  minHeightM?: number;
  /** Minimum mid-deck traffic yield capacity (kN). Requires a painted deck. */
  minTruckCapacitykN?: number;
  /** Minimum ramp capacity factor λ under the model's reference loads. */
  minRampLambda?: number;
  /**
   * When set, ramp λ is evaluated with this horizontal tip load (N) applied at
   * the highest node (replacing point loads). docs/FEM-SPEC.md §14 2G.
   */
  probeTipLoadN?: number;
  /**
   * When true, supports may exist only on the two outermost supported nodes
   * (no intermediate piers). docs/FEM-SPEC.md §14 2G.
   */
  abutmentsOnly?: boolean;
}

export interface ChallengeCheck {
  id: string;
  label: string;
  ok: boolean;
  actual: string;
  required: string;
}

/** Pass/fail verdict with the numbers that decide each check. docs/FEM-SPEC.md §14 2G. */
export interface ChallengeVerdict {
  challengeId: string;
  passed: boolean;
  checks: ChallengeCheck[];
  steelMassKg: number;
  clearSpanM: number;
  heightM: number;
  truckCapacitykN?: number;
  rampLambda?: number;
}
