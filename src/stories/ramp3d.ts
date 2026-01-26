/**
 * Load-ramp orchestration for 3D space frames.
 */
import { analyzeAtFactor3d, collapseCascade3d, evaluateFailure3d } from '../fem/space/failure';
import type { StaticAnalysis3d } from '../fem/space/statics';
import type { CascadeResult, FailureReport } from '../fem/types';
import type { EditorModel3d } from '../fem/space/types';

export interface RampFrame3d {
  factor: number;
  analysis: StaticAnalysis3d;
  report?: FailureReport;
  cascade?: CascadeResult;
}

/** Exact first-limit capacity under proportional static loading. */
export function rampCapacity3d(model: EditorModel3d): number | undefined {
  try {
    const report = evaluateFailure3d(model, 1);
    if (report.kind === 'stable') return report.capacityFactor;
    if (report.kind === 'buckling') return report.lambdaCr;
    if (report.kind === 'yield') return report.utilization > 0 ? 1 / report.utilization : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Analyze, classify, and optionally build the cascade. */
export function analyzeRamp3d(model: EditorModel3d, factor: number, includeCascade = false): RampFrame3d {
  const safeFactor = Math.max(0.001, factor);
  const analysis = analyzeAtFactor3d(model, safeFactor);
  if (analysis.kind === 'invalid' || analysis.kind === 'mechanism') return { factor: safeFactor, analysis };
  try {
    const report = evaluateFailure3d(model, safeFactor);
    return {
      factor: safeFactor,
      analysis,
      report,
      cascade: includeCascade && report.kind !== 'stable' ? collapseCascade3d(model, safeFactor) : undefined,
    };
  } catch {
    return { factor: safeFactor, analysis };
  }
}
