/** Challenge catalog types. */
import type { EditorModel } from '../fem/types';

/** Constrained-budget challenge definition. */
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
 * Steel mass always counts only `steel-s355` members.
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
   * the highest node (replacing point loads).
   */
  probeTipLoadN?: number;
  /**
   * When true, supports may exist only on the two outermost supported nodes
   * (no intermediate piers).
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

/** Pass/fail verdict with the numbers that decide each check. */
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
