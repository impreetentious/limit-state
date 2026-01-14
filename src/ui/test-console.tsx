'use client';

import { useMemo } from 'react';
import { dynamicAmplificationRatio } from '../fem/dynamics';
import { evaluateFailure } from '../fem/failure';
import { buildMesh } from '../fem/mesh';
import type { EditorModel, EigenResult } from '../fem/types';
import { useEditorStore } from '../state/editor-store';

/** Test-story controls and the always-visible truth/capacity readout. */
export function TestConsole({ model, modal, buckling, onReturn }: { model: EditorModel; modal?: EigenResult; buckling?: EigenResult; onReturn: () => void }): React.JSX.Element {
  const story = useEditorStore((state) => state.model.story);
  const setStory = useEditorStore((state) => state.setStory);
  const failure = useMemo(() => {
    try { return evaluateFailure(model, 1); } catch { return undefined; }
  }, [model]);
  const massTons = useMemo(() => {
    try {
      const mesh = buildMesh(model);
      return mesh.elements.reduce((sum, element) => sum + element.rho * element.A * element.L, 0) / 1000;
    } catch { return 0; }
  }, [model]);
  const f1 = modal?.values[0] ? modal.values[0]! / (Math.PI * 2) : undefined;
  const daf = story.kind === 'wind' && f1 ? dynamicAmplificationRatio(story.freqHz * Math.PI * 2, modal!.values[0]!, story.zeta) : undefined;
  const capacity = failure?.kind === 'stable' ? failure.capacityFactor : undefined;

  return <section className="test-console" aria-label="Test stories and capacity">
    <div className="test-console-header"><span>Test Console</span><button type="button" onClick={onReturn}>Return to Build</button></div>
    <div className="story-tabs">
      {(['traffic', 'wind', 'ramp'] as const).map((kind) => <button key={kind} type="button" className={story.kind === kind ? 'active' : ''} onClick={() => {
        if (kind === 'traffic') setStory({ kind, weightkN: 300, speed: 12 });
        if (kind === 'wind') setStory({ kind, pattern: 'sine', amplitudekNm: 2, freqHz: Math.max(0.05, f1 ?? 1), zeta: 0.02 });
        if (kind === 'ramp') setStory({ kind });
      }}>{kind}</button>)}
    </div>
    {story.kind === 'traffic' && <div className="story-fields">
      <label>Vehicle {story.weightkN.toFixed(0)} kN<input type="range" min="10" max="500" step="10" value={story.weightkN} onChange={(event) => setStory({ ...story, weightkN: Number(event.target.value) })} /></label>
      <label>Speed {story.speed.toFixed(0)} m/s<input type="range" min="5" max="30" step="1" value={story.speed} onChange={(event) => setStory({ ...story, speed: Number(event.target.value) })} /></label>
      <p>Two axles, 4 m apart · quasi-static — real vehicles add roughly 10–30% dynamic amplification.</p>
    </div>}
    {story.kind === 'wind' && <div className="story-fields">
      <label>Pattern <select value={story.pattern} onChange={(event) => setStory({ ...story, pattern: event.target.value as typeof story.pattern })}><option value="steady">steady</option><option value="sine">sine</option><option value="gusts">gusts</option></select></label>
      <label>Frequency {story.freqHz.toFixed(2)} Hz<input type="range" min="0.05" max="5" step="0.05" value={story.freqHz} onChange={(event) => setStory({ ...story, freqHz: Number(event.target.value) })} /></label>
      <label>Damping {(story.zeta * 100).toFixed(1)}%<input type="range" min="0.005" max="0.1" step="0.005" value={story.zeta} onChange={(event) => setStory({ ...story, zeta: Number(event.target.value) })} /></label>
      <p>Simplified uniform wind field{daf ? ` · DAF ${daf.toFixed(2)} at f₁` : ''}.</p>
    </div>}
    {story.kind === 'ramp' && <div className="story-fields">
      <p>Proportional load ramp: {describeFailure(failure)}</p>
      <p>Quasi-static sequence — inertia not modeled.</p>
    </div>}
    <div className="capacity-panel">
      <span>{capacity && Number.isFinite(capacity) ? `Capacity λ ${capacity.toFixed(2)}` : 'Capacity needs a stable loaded model'}</span>
      <span>{buckling?.values[0] ? `Buckling λ ${buckling.values[0]!.toFixed(2)}` : 'Buckling: no compression'}</span>
      <span>{f1 ? `f₁ ${f1.toFixed(2)} Hz` : 'f₁ unavailable'}</span>
      <span>Mass {massTons.toFixed(2)} t</span>
    </div>
  </section>;
}

function describeFailure(failure: ReturnType<typeof evaluateFailure> | undefined): string {
  if (!failure) return 'stability is required before a ramp can run.';
  if (failure.kind === 'stable') return `governed by ${failure.governedBy} at λ ${formatFinite(failure.capacityFactor)}.`;
  if (failure.kind === 'mechanism') return `mechanism at node ${failure.nodeId}.`;
  if (failure.kind === 'yield') return `yield at member ${failure.memberId} (U ${failure.utilization.toFixed(2)}).`;
  if (failure.kind === 'buckling') return `${failure.governs} buckling at member ${failure.memberId} (λ ${failure.lambdaCr.toFixed(2)}).`;
  return `resonance with mode ${failure.mode} at ${failure.freqHz.toFixed(2)} Hz.`;
}

function formatFinite(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}
