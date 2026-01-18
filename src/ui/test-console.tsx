'use client';

import { useMemo } from 'react';
import { evaluateFailure } from '../fem/failure';
import { buildMesh } from '../fem/mesh';
import type { EditorModel, EigenResult, FailureReport } from '../fem/types';
import type { RampFrame } from '../stories/ramp';
import type { TrafficFrame } from '../stories/traffic';
import type { WindScenario } from '../stories/wind';
import { useEditorStore } from '../state/editor-store';

interface WindFrame {
  scenario: WindScenario;
  t: number;
  coordinates: Float64Array;
  daf?: { mode: number; ratio: number };
  resonanceMode?: number;
  yieldMember?: number;
}

interface TestConsoleProps {
  model: EditorModel;
  modal?: EigenResult;
  buckling?: EigenResult;
  playing: boolean;
  storyTime: number;
  traffic?: TrafficFrame;
  /** Undefined while playback is active; null means this station has no finite yield limit. */
  trafficYieldCapacity?: number | null;
  envelopeEnabled: boolean;
  onEnvelopeEnabled: (enabled: boolean) => void;
  ramp?: RampFrame;
  rampCapacity?: number;
  wind?: WindFrame;
  onTogglePlayback: () => void;
  onRestart: () => void;
  onSeekTrafficStation: (station: number) => void;
  onReplayFailure: () => void;
  onReturn: () => void;
}

/** Test-story controls, real playback state, and capacity/failure explanation. */
export function TestConsole({
  model, modal, buckling, playing, storyTime, traffic, trafficYieldCapacity, envelopeEnabled, onEnvelopeEnabled, ramp, rampCapacity, wind, onTogglePlayback, onRestart, onSeekTrafficStation, onReplayFailure, onReturn,
}: TestConsoleProps): React.JSX.Element {
  const story = useEditorStore((state) => state.model.story);
  const setStory = useEditorStore((state) => state.setStory);
  const failure = useMemo(() => {
    try { return evaluateFailure(model, 1); } catch { return undefined; }
  }, [model]);
  const massKg = useMemo(() => {
    try {
      const mesh = buildMesh(model);
      return mesh.elements.reduce((sum, element) => sum + element.rho * element.A * element.L, 0);
    } catch { return 0; }
  }, [model]);
  const referenceLoadN = useMemo(() => {
    const pointLoad = model.loads.points.reduce((sum, point) => sum + Math.hypot(point.fx, point.fy), 0);
    if (!model.loads.gravity) return pointLoad;
    return pointLoad + massKg * 9.80665;
  }, [massKg, model.loads]);
  const f1 = modal?.values[0] ? modal.values[0]! / (Math.PI * 2) : undefined;
  const capacity = failure?.kind === 'stable' ? failure.capacityFactor : undefined;
  const capacityToWeight = capacity && Number.isFinite(capacity) && massKg > 0 && referenceLoadN > 0
    ? capacity * referenceLoadN / massKg
    : undefined;
  const frontStation = story.kind === 'traffic' ? storyTime * story.speed : 0;
  const windMarks = modal ? Array.from(modal.values.slice(0, 4), (value, index) => ({ label: `f${index + 1}`, value: value / (Math.PI * 2) })) : [];

  return <section className="test-console" aria-label="Test stories and capacity">
    <div className="test-console-header"><span>Test Console</span><button type="button" onClick={onReturn}>Return to Build</button></div>
    <div className="story-tabs">
      {(['traffic', 'wind', 'ramp'] as const).map((kind) => <button key={kind} type="button" className={story.kind === kind ? 'active' : ''} onClick={() => {
        if (kind === 'traffic') setStory({ kind, weightkN: 300, speed: 12 });
        if (kind === 'wind') setStory({ kind, pattern: 'sine', amplitudekNm: 2, freqHz: Math.min(5, Math.max(0.05, f1 ?? 1)), zeta: 0.02 });
        if (kind === 'ramp') setStory({ kind });
      }}>{kind}</button>)}
    </div>
    <div className="story-transport">
      <button type="button" className="play-button" onClick={onTogglePlayback}>{playing ? 'Pause' : 'Play'} <kbd>Space</kbd></button>
      <button type="button" onClick={onRestart}>Restart</button>
      <span>{story.kind === 'wind' ? `t ${storyTime.toFixed(2)} s` : story.kind === 'ramp' ? `λ ${(ramp?.factor ?? 0).toFixed(2)}` : `station ${frontStation.toFixed(1)} m`}</span>
    </div>
    {story.kind === 'traffic' && <div className="story-fields">
      <label>Vehicle {story.weightkN.toFixed(0)} kN<input type="range" min="10" max="500" step="10" value={story.weightkN} onChange={(event) => setStory({ ...story, weightkN: Number(event.target.value) })} /></label>
      <label>Speed {story.speed.toFixed(0)} m/s<input type="range" min="5" max="30" step="1" value={story.speed} onChange={(event) => setStory({ ...story, speed: Number(event.target.value) })} /></label>
      <label>Truck station {frontStation.toFixed(1)} m<input aria-label="Truck station" type="range" min="0" max={Math.max(0, traffic?.length ?? 0)} step="0.05" value={Math.min(Math.max(0, frontStation), Math.max(0, traffic?.length ?? 0))} disabled={!traffic || traffic.length === 0} onChange={(event) => onSeekTrafficStation(Number(event.target.value))} /></label>
      <label className="envelope-toggle"><input type="checkbox" checked={envelopeEnabled} onChange={(event) => onEnvelopeEnabled(event.target.checked)} /> Moment envelope</label>
      <p>Two axles, 4 m apart · {traffic ? `${traffic.length.toFixed(1)} m deck sweep` : 'paint a contiguous deck path'} · quasi-static — real vehicles add roughly 10–30% dynamic amplification.</p>
    </div>}
    {story.kind === 'wind' && <div className="story-fields">
      <label>Pattern <select value={story.pattern} onChange={(event) => setStory({ ...story, pattern: event.target.value as typeof story.pattern })}><option value="steady">steady</option><option value="sine">sine</option><option value="gusts">gusts</option></select></label>
      <label>Amplitude {story.amplitudekNm.toFixed(1)} kN/m<input type="range" min="0.1" max="10" step="0.1" value={story.amplitudekNm} onChange={(event) => setStory({ ...story, amplitudekNm: Number(event.target.value) })} /></label>
      <label>Frequency {story.freqHz.toFixed(2)} Hz<input list="wind-frequency-marks" type="range" min="0.05" max="5" step="0.05" value={story.freqHz} onChange={(event) => setStory({ ...story, freqHz: Number(event.target.value) })} /></label>
      <datalist id="wind-frequency-marks">{windMarks.filter((mark) => mark.value >= 0.05 && mark.value <= 5).map((mark) => <option key={mark.label} value={mark.value.toFixed(2)} label={`${mark.label} ${mark.value.toFixed(2)} Hz`} />)}</datalist>
      <label>Damping {(story.zeta * 100).toFixed(1)}%<input type="range" min="0.005" max="0.1" step="0.005" value={story.zeta} onChange={(event) => setStory({ ...story, zeta: Number(event.target.value) })} /></label>
      <p>Simplified uniform wind field (member-normal 2D pressure){wind?.daf ? ` · measured DAF ${wind.daf.ratio.toFixed(2)} at q${wind.daf.mode + 1}` : ''}.</p>
      {model.name === 'Slender deck' && <p className="honesty-note">Tacoma Narrows is an inspiration only: this is a linear in-plane beam model, not an aeroelastic flutter simulation.</p>}
      {wind?.resonanceMode !== undefined && <div className="resonance-panel" role="status">{wind.yieldMember !== undefined ? `Resonance → yield at member ${wind.yieldMember}` : `Resonance with mode ${wind.resonanceMode + 1} (${(modal?.values[wind.resonanceMode]! / (Math.PI * 2)).toFixed(2)} Hz)`}</div>}
      {wind && <ModeBars coordinates={wind.coordinates} modal={modal} />}
    </div>}
    {story.kind === 'ramp' && <div className="story-fields">
      <p>Proportional load ramp: {describeFailure(ramp?.report ?? failure)}</p>
      <p>Stops at the exact first limit {rampCapacity && Number.isFinite(rampCapacity) ? `λ ${rampCapacity.toFixed(2)}` : 'when a stable reference load exists'} · quasi-static sequence — inertia not modeled.</p>
      {ramp?.report && ramp.report.kind !== 'stable' && <FailurePanel report={ramp.report} ramp={ramp} onReplay={onReplayFailure} />}
    </div>}
    <div className="capacity-panel">
      <span>{capacity && Number.isFinite(capacity) ? `Capacity λ ${capacity.toFixed(2)}` : 'Capacity needs a stable loaded model'}</span>
      <span>{buckling?.values[0] ? `Buckling λ ${buckling.values[0]!.toFixed(2)}` : 'Buckling: no compression'}</span>
      <span>{f1 ? `f₁ ${f1.toFixed(2)} Hz` : 'f₁ unavailable'}</span>
      <span>Mass {(massKg / 1000).toFixed(2)} t</span>
      <span>{capacityToWeight ? `Capacity/weight ${capacityToWeight.toFixed(2)} kN/t` : 'Capacity/weight needs a reference load'}</span>
      {story.kind === 'traffic' && <span>{trafficCapacityLabel(trafficYieldCapacity)}</span>}
    </div>
  </section>;
}

function ModeBars({ coordinates, modal }: { coordinates: Float64Array; modal?: EigenResult }): React.JSX.Element | null {
  if (!modal || coordinates.length === 0) return null;
  const maximum = Math.max(...Array.from(coordinates, (value) => Math.abs(value)), 1e-12);
  return <div className="mode-energy" aria-label="Modal response coordinates">
    {Array.from(coordinates.slice(0, 4), (value, index) => <div key={index}><span>q{index + 1}</span><i style={{ width: `${Math.max(3, Math.abs(value) / maximum * 100)}%` }} /><b>{value.toExponential(1)}</b></div>)}
  </div>;
}

function FailurePanel({ report, ramp, onReplay }: { report: Exclude<FailureReport, { kind: 'stable' }>; ramp: RampFrame; onReplay: () => void }): React.JSX.Element {
  return <div className="failure-panel" role="status">
    <strong>Failure: {describeFailure(report)}</strong>
    <button type="button" onClick={onReplay}>Replay failure</button>
    <details>
      <summary>Why this happened</summary>
      <p className="failure-formula">{failureFormula(report)}</p>
      <p>{failureWhy(report)}</p>
      {ramp.cascade && <ol>{ramp.cascade.steps.map((step, index) => <li key={`${step.memberId}-${index}`}>{step.detail}</li>)}</ol>}
      {ramp.cascade?.steps.length === 0 && <p>No additional cascade step was needed to identify the first limit.</p>}
    </details>
  </div>;
}

function failureFormula(failure: Exclude<FailureReport, { kind: 'stable' }>): string {
  if (failure.kind === 'mechanism') return `Kff is singular at node ${failure.nodeId}: no constrained equilibrium exists.`;
  if (failure.kind === 'yield') return `U = |N/A ± Mc/I| / fy = ${failure.utilization.toFixed(2)} at λ = ${failure.loadFactor.toFixed(2)}.`;
  if (failure.kind === 'buckling') return failure.governs === 'member' && failure.memberN !== undefined && failure.memberNCr !== undefined
    ? `|N| / Ncr = ${Math.abs(failure.memberN / failure.memberNCr).toFixed(2)}; N = ${formatForce(failure.memberN)}, Ncr = ${formatForce(failure.memberNCr)}.`
    : `det(K + λKg) = 0 gives λcr = ${failure.lambdaCr.toFixed(2)}.`;
  return `|f − fi| / fi ≤ 10%, ζ < 5%, and the five-cycle modal envelope grew > 1.5×.`;
}

function trafficCapacityLabel(capacity: number | null | undefined): string {
  if (typeof capacity === 'number') return `Max truck (yield) ${capacity.toFixed(0)} kN`;
  if (capacity === null) return 'Max truck (yield): no finite limit at this station';
  return 'Max truck: pause to estimate';
}

function describeFailure(failure: FailureReport | undefined): string {
  if (!failure) return 'stability is required before a ramp can run.';
  if (failure.kind === 'stable') return `governed by ${failure.governedBy} at λ ${formatFinite(failure.capacityFactor)}.`;
  if (failure.kind === 'mechanism') return `mechanism at node ${failure.nodeId}.`;
  if (failure.kind === 'yield') return `yield at member ${failure.memberId} (U ${failure.utilization.toFixed(2)}).`;
  if (failure.kind === 'buckling') return `${failure.governs} buckling at member ${failure.memberId} (λ ${failure.lambdaCr.toFixed(2)}).`;
  return `resonance with mode ${failure.mode + 1} at ${failure.freqHz.toFixed(2)} Hz.`;
}

function failureWhy(failure: Exclude<FailureReport, { kind: 'stable' }>): string {
  if (failure.kind === 'mechanism') return `The constrained stiffness matrix has a free motion at node ${failure.nodeId}; a load factor cannot create a stable equilibrium.`;
  if (failure.kind === 'yield') return `Member ${failure.memberId} reaches combined stress utilization ${failure.utilization.toFixed(2)} at λ ${failure.loadFactor.toFixed(2)}.`;
  if (failure.kind === 'buckling') return failure.governs === 'member' && failure.memberN !== undefined && failure.memberNCr !== undefined
    ? `Member ${failure.memberId} compression ${formatForce(failure.memberN)} reaches its Euler capacity ${formatForce(failure.memberNCr)}.`
    : `The global geometric-stiffness eigenproblem gives λcr ${failure.lambdaCr.toFixed(2)} for the compression pattern, led by member ${failure.memberId}.`;
  return `Forcing is near mode ${failure.mode + 1} at ${failure.freqHz.toFixed(2)} Hz; the measured modal envelope over five cycles and damping threshold classify the response as resonance.`;
}

function formatForce(value: number): string { return `${(value / 1000).toFixed(1)} kN`; }
function formatFinite(value: number): string { return Number.isFinite(value) ? value.toFixed(2) : '∞'; }
