/**
 * Load-ramp orchestration for the explainer layer. The calculations remain in
 * the pure FEM kernel; this module selects an exact proportional load state.
 */
import { analyzeAtFactor, collapseCascade, evaluateFailure } from '../fem/failure';
import type { StaticAnalysis } from '../fem/statics';
import type { AnalysisOptions, CascadeResult, EditorModel, FailureReport } from '../fem/types';

export interface RampFrame {
  factor: number;
  analysis: StaticAnalysis;
  report?: FailureReport;
  cascade?: CascadeResult;
}

/** Exact first-limit capacity under proportional static loading. */
export function rampCapacity(
  model: EditorModel,
  options: AnalysisOptions = {},
): number | undefined {
  try {
    const report = evaluateFailure(model, 1, options);
    if (report.kind === 'stable') return report.capacityFactor;
    if (report.kind === 'buckling') return report.lambdaCr;
    if (report.kind === 'yield') return report.utilization > 0 ? 1 / report.utilization : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Analyze, classify, and (once failure occurs) build the deterministic cascade. */
export function analyzeRamp(
  model: EditorModel,
  factor: number,
  includeCascade = false,
  options: AnalysisOptions = {},
): RampFrame {
  const safeFactor = Math.max(0.001, factor);
  const analysis = analyzeAtFactor(model, safeFactor, options);
  if (analysis.kind === 'invalid' || analysis.kind === 'mechanism' || analysis.kind === 'divergent')
    return { factor: safeFactor, analysis };
  try {
    const report = evaluateFailure(model, safeFactor, options);
    return {
      factor: safeFactor,
      analysis,
      report,
      cascade:
        includeCascade && report.kind !== 'stable'
          ? collapseCascade(model, safeFactor, options)
          : undefined,
    };
  } catch {
    return { factor: safeFactor, analysis };
  }
}
