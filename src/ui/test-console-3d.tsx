/**
 * 3D Test-story controls, capacity / failure explanation, and honesty labels.
 * Reuses 2D failure copy patterns.
 */
'use client';

import { useMemo } from 'react';
import { MATERIALS, sectionProps } from '../fem/materials';
import { evaluateFailure3d } from '../fem/space/failure';
import type { PushoverResult3d } from '../fem/space/pushover';
import type { EditorModel3d, StorySpec3d } from '../fem/space/types';
import type { FailureReport } from '../fem/types';
import { earthquakeRecords } from '../fem/records';
import type { EarthquakeScenario3d } from '../stories/earthquake3d';
import type { RampFrame3d } from '../stories/ramp3d';
import type { TrafficFrame3d } from '../stories/traffic3d';

interface Props {
  model: EditorModel3d;
  modalFreqHz?: number;
  bucklingLambda?: number;
  playing: boolean;
  storyTime: number;
  traffic?: TrafficFrame3d;
  ramp?: RampFrame3d;
  rampCapacity?: number;
  pushover?: PushoverResult3d;
  earthquake?: { scenario: EarthquakeScenario3d; t: number; yieldMember?: number };
  onTogglePlayback: () => void;
  onRestart: () => void;
  onSetStory: (kind: StorySpec3d['kind']) => void;
  onPatchTraffic: (partial: Partial<Extract<StorySpec3d, { kind: 'traffic' }>>) => void;
  onPatchWind: (partial: Partial<Extract<StorySpec3d, { kind: 'wind' }>>) => void;
  onPatchEarthquake: (partial: Partial<Extract<StorySpec3d, { kind: 'earthquake' }>>) => void;
  onReplayFailure: () => void;
}

export function TestConsole3d({
  model,
  modalFreqHz,
  bucklingLambda,
  playing,
  storyTime,
  traffic,
  ramp,
  rampCapacity,
  pushover,
  earthquake,
  onTogglePlayback,
  onRestart,
  onSetStory,
  onPatchTraffic,
  onPatchWind,
  onPatchEarthquake,
  onReplayFailure,
}: Props): React.JSX.Element {
  const story = model.story ?? { kind: 'wind' as const, pattern: 'sine' as const, amplitudekNm: 3, freqHz: 0.5, zeta: 0.02, directionDeg: 0 };
  const massKg = useMemo(() => modelMassKg(model), [model]);
  const referenceLoadN = useMemo(() => referenceLoadMagnitude(model), [model]);
  const failure = useMemo(() => {
    try {
      return evaluateFailure3d(model, 1);
    } catch {
      return undefined;
    }
  }, [model]);
  const capacity = failure?.kind === 'stable' ? failure.capacityFactor : undefined;
  const capacityToWeight = capacity && Number.isFinite(capacity) && massKg > 0 && referenceLoadN > 0
    ? capacity * referenceLoadN / massKg
    : undefined;

  return (
    <aside className="wind3d-panel test-console-3d" aria-label="3D story controls">
      <div className="wind3d-header">
        <strong>Stories (3D)</strong>
        <button type="button" className="play-button" onClick={onTogglePlayback}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="quiet-button" onClick={onRestart}>Restart</button>
      </div>
      <div className="mode-family" aria-label="3D story kind">
        {(['wind', 'traffic', 'earthquake', 'ramp', 'pushover'] as const).map((kind) => (
          <button key={kind} type="button" className={story.kind === kind ? 'active' : ''} onClick={() => onSetStory(kind)}>
            {kind[0]!.toUpperCase() + kind.slice(1)}
          </button>
        ))}
      </div>
      <p className="rail-hint">
        {story.kind === 'traffic' ? `t = ${storyTime.toFixed(2)} s`
          : story.kind === 'ramp' ? `λ ${(ramp?.factor ?? 0).toFixed(2)}`
            : story.kind === 'pushover' ? `H ${((pushover?.collapseBaseShear ?? 0) / 1000).toFixed(1)} kN collapse`
              : story.kind === 'earthquake' ? `t = ${(earthquake?.t ?? 0).toFixed(2)} s`
                : `t = ${storyTime.toFixed(2)} s`}
      </p>

      {story.kind === 'wind' && (
        <>
          <label className="snap-toggle">Direction
            <input type="range" min={0} max={360} step={5} value={story.directionDeg} onChange={(e) => onPatchWind({ directionDeg: Number(e.target.value) })} aria-label="Wind direction" />
            <span>{story.directionDeg.toFixed(0)}° from +X</span>
          </label>
          <label className="snap-toggle">Pattern
            <select value={story.pattern} onChange={(e) => onPatchWind({ pattern: e.target.value as 'steady' | 'sine' | 'gusts' })} aria-label="Wind pattern">
              <option value="steady">Steady</option>
              <option value="sine">Sine</option>
              <option value="gusts">Gusts</option>
            </select>
          </label>
          <p className="rail-hint">Horizontal pressure along the dial. Warping / member-level LTB still out of scope.</p>
        </>
      )}

      {story.kind === 'traffic' && (
        <>
          <label className="snap-toggle">Weight (kN)
            <input type="number" min={10} step={10} value={story.weightkN} onChange={(e) => onPatchTraffic({ weightkN: Number(e.target.value) || 10 })} aria-label="Traffic weight" />
          </label>
          <label className="snap-toggle">Speed (m/s)
            <input type="number" min={1} step={1} value={story.speed} onChange={(e) => onPatchTraffic({ speed: Number(e.target.value) || 1 })} aria-label="Traffic speed" />
          </label>
          <label className="envelope-toggle">
            <input type="checkbox" checked={story.movingMass} onChange={(e) => onPatchTraffic({ movingMass: e.target.checked })} /> Moving mass
          </label>
          <p className="rail-hint">
            Two axles, 4 m apart, weight along −Z.
            {story.movingMass
              ? ` · moving-mass Newmark (ζ = 2%)${traffic?.movingMass ? ` · amp ×${traffic.movingMass.amplification.toFixed(2)} vs static` : ''}`
              : ' · quasi-static'}
            {model.deck?.length ? '' : ' · no deck yet'}
          </p>
        </>
      )}

      {story.kind === 'earthquake' && (
        <>
          <label className="snap-toggle">Record
            <select value={story.record} onChange={(e) => onPatchEarthquake({ record: e.target.value as typeof story.record })} aria-label="Earthquake record">
              {earthquakeRecords().map((record) => <option key={record.id} value={record.id}>{record.label}</option>)}
            </select>
          </label>
          <label className="snap-toggle">Scale
            <input type="number" min={0.1} step={0.1} value={story.scale} onChange={(e) => onPatchEarthquake({ scale: Number(e.target.value) || 0.1 })} aria-label="Earthquake scale" />
          </label>
          <label className="snap-toggle">ζ
            <input type="number" min={0.005} max={0.1} step={0.005} value={story.zeta} onChange={(e) => onPatchEarthquake({ zeta: Number(e.target.value) || 0.05 })} aria-label="Damping ratio" />
          </label>
          <p className="rail-hint">Base excitation −M·ι·ü_g with horizontal ι (global X). {earthquake?.yieldMember !== undefined ? `Yield concern at member ${earthquake.yieldMember}.` : ''}</p>
          {earthquake?.scenario && (
            <p className="rail-hint">
              Spectrum Sa peak {(Math.max(...earthquake.scenario.spectrum.points.map((p) => p.sa)) / 9.80665).toFixed(2)} g
              over {earthquake.scenario.spectrum.points.length} periods.
            </p>
          )}
        </>
      )}

      {story.kind === 'ramp' && (
        <>
          <p>Proportional load ramp: {describeFailure(ramp?.report ?? failure)}</p>
          <p>Stops at the exact first limit {rampCapacity && Number.isFinite(rampCapacity) ? `λ ${rampCapacity.toFixed(2)}` : 'when a stable reference load exists'} · quasi-static sequence — inertia not modeled.</p>
          {ramp?.report && ramp.report.kind !== 'stable' && (
            <div className="failure-panel" role="status">
              <strong>{describeFailure(ramp.report)}</strong>
              <button type="button" onClick={onReplayFailure}>Replay failure</button>
              <p className="failure-formula">{failureFormula(ramp.report)}</p>
              <p>{failureWhy(ramp.report)}</p>
              {ramp.cascade && <ol>{ramp.cascade.steps.map((step, index) => <li key={`${step.memberId}-${index}`}>{step.detail}</li>)}</ol>}
            </div>
          )}
        </>
      )}

      {story.kind === 'pushover' && (
        <>
          <p>Plastic pushover — hinges when √(My²+Mz²) reaches M_p = Z·f_y.</p>
          {pushover ? (
            <div className="pushover-panel">
              <p>Collapse H {(pushover.collapseBaseShear / 1000).toFixed(1)} kN at λ {pushover.collapseLoadFactor.toFixed(2)} · {pushover.outcome} · {pushover.hinges.length} hinge{pushover.hinges.length === 1 ? '' : 's'}</p>
              <ol>{pushover.hinges.map((hinge, i) => <li key={`${hinge.memberId}-${hinge.end}-${i}`}>Member {hinge.memberId} end {hinge.end.toUpperCase()} at λ {hinge.loadFactor.toFixed(2)}</li>)}</ol>
            </div>
          ) : <p>Add lateral point loads to run a pushover curve.</p>}
        </>
      )}

      <div className="capacity-panel">
        <span>{capacity && Number.isFinite(capacity) ? `Capacity λ ${capacity.toFixed(2)}` : 'Capacity needs a stable loaded model'}</span>
        <span>{bucklingLambda !== undefined ? `Buckling λcr ${bucklingLambda.toFixed(2)}` : 'No buckling under this load direction'}</span>
        <span>{modalFreqHz !== undefined ? `f₁ ${modalFreqHz.toFixed(2)} Hz` : 'f₁ needs a modal solve'}</span>
        <span>Mass {(massKg / 1000).toFixed(2)} t</span>
        <span>{capacityToWeight ? `Capacity/weight ${capacityToWeight.toFixed(2)} kN/t` : 'Capacity/weight needs a reference load'}</span>
      </div>
    </aside>
  );
}

function modelMassKg(model: EditorModel3d): number {
  let mass = 0;
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const member of model.members) {
    const a = byId.get(member.a);
    const b = byId.get(member.b);
    if (!a || !b) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    mass += MATERIALS[member.material].rho * sectionProps(member.section).A * L;
  }
  return mass;
}

function referenceLoadMagnitude(model: EditorModel3d): number {
  let sum = 0;
  for (const point of model.loads.points) sum += Math.hypot(point.fx, point.fy, point.fz);
  return sum;
}

function describeFailure(failure: FailureReport | undefined): string {
  if (!failure) return 'stability is required before a ramp can run.';
  if (failure.kind === 'stable') return `governed by ${failure.governedBy} at λ ${formatFinite(failure.capacityFactor)}.`;
  if (failure.kind === 'mechanism') return `mechanism at node ${failure.nodeId}.`;
  if (failure.kind === 'yield') return `yield at member ${failure.memberId} (U ${failure.utilization.toFixed(2)}).`;
  if (failure.kind === 'buckling') return `${failure.governs} buckling at member ${failure.memberId} (λ ${failure.lambdaCr.toFixed(2)}).`;
  return `resonance with mode ${failure.mode + 1} at ${failure.freqHz.toFixed(2)} Hz.`;
}

function failureFormula(failure: Exclude<FailureReport, { kind: 'stable' }>): string {
  if (failure.kind === 'mechanism') return `Kff is singular at node ${failure.nodeId}: no constrained equilibrium exists.`;
  if (failure.kind === 'yield') return `U = |N/A ± Mc/I| / fy = ${failure.utilization.toFixed(2)} at λ = ${failure.loadFactor.toFixed(2)}.`;
  if (failure.kind === 'buckling') {
    return failure.governs === 'member' && failure.memberN !== undefined && failure.memberNCr !== undefined
      ? `|N| / Ncr = ${Math.abs(failure.memberN / failure.memberNCr).toFixed(2)}; N = ${formatForce(failure.memberN)}, Ncr = ${formatForce(failure.memberNCr)}.`
      : `det(K + λKg) = 0 gives λcr = ${failure.lambdaCr.toFixed(2)}.`;
  }
  return `Resonance detector fired for mode ${failure.mode + 1}.`;
}

function failureWhy(failure: Exclude<FailureReport, { kind: 'stable' }>): string {
  if (failure.kind === 'mechanism') return `The constrained stiffness matrix has a free motion at node ${failure.nodeId}.`;
  if (failure.kind === 'yield') return `Member ${failure.memberId} reaches combined stress utilization ${failure.utilization.toFixed(2)} at λ ${failure.loadFactor.toFixed(2)}.`;
  if (failure.kind === 'buckling') {
    return failure.governs === 'member' && failure.memberN !== undefined && failure.memberNCr !== undefined
      ? `Member ${failure.memberId} compression ${formatForce(failure.memberN)} reaches its Euler capacity ${formatForce(failure.memberNCr)}.`
      : `The global geometric-stiffness eigenproblem gives λcr ${failure.lambdaCr.toFixed(2)}, led by member ${failure.memberId}.`;
  }
  return `Forcing is near mode ${failure.mode + 1} at ${failure.freqHz.toFixed(2)} Hz.`;
}

function formatFinite(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

function formatForce(value: number): string {
  return `${(value / 1000).toFixed(1)} kN`;
}
