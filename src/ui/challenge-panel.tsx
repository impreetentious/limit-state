'use client';

/**
 * Challenge checklist overlay. docs/FEM-SPEC.md §14 2G.
 */
import { useMemo } from 'react';
import { challengeById } from '../challenges/catalog';
import { evaluateChallenge } from '../challenges/evaluate';
import type { AnalysisOptions, EditorModel } from '../fem/types';

export function ChallengePanel({
  challengeId,
  model,
  analysisOptions,
  onClear,
}: {
  challengeId: string;
  model: EditorModel;
  analysisOptions: AnalysisOptions;
  onClear: () => void;
}): React.JSX.Element | null {
  const challenge = challengeById(challengeId);
  const verdict = useMemo(
    () => (challenge ? evaluateChallenge(challenge, model, analysisOptions) : undefined),
    [analysisOptions, challenge, model],
  );
  if (!challenge || !verdict) return null;

  return (
    <aside
      className={`challenge-panel ${verdict.passed ? 'challenge-passed' : ''}`}
      aria-label="Challenge checklist"
    >
      <div className="challenge-panel-header">
        <div>
          <strong>{challenge.label}</strong>
          <p>{challenge.brief}</p>
        </div>
        <button type="button" className="quiet-button" onClick={onClear}>
          Leave
        </button>
      </div>
      <ul className="challenge-checks">
        {verdict.checks.map((check) => (
          <li key={check.id} className={check.ok ? 'ok' : 'fail'}>
            <span className="challenge-mark" aria-hidden>
              {check.ok ? '✓' : '·'}
            </span>
            <span>
              <strong>{check.label}</strong>
              <span className="challenge-numbers">
                {check.actual} · need {check.required}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="challenge-status" role="status">
        {verdict.passed
          ? 'Challenge cleared — share the URL if you want the solution in the gallery sense.'
          : 'Build within the budget. Steel mass counts only steel-s355 members.'}
      </p>
    </aside>
  );
}
