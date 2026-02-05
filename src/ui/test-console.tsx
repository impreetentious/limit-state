'use client';

import { useMemo, useState } from 'react';
import { evaluateFailure } from '../fem/failure';
import {
  computeInfluenceLine,
  envelopeFromInfluence,
  type InfluenceLine,
  type InfluenceQuantity,
} from '../fem/influence';
import { modelHasCables, solveTensionOnly } from '../fem/cables';
import { type PushoverResult } from '../fem/pushover';
import { buildMesh } from '../fem/mesh';
import { earthquakeRecords } from '../fem/records';
import type {
  AnalysisOptions,
  EarthquakeRecordId,
  EditorModel,
  EigenResult,
  FailureReport,
} from '../fem/types';
import type { EarthquakeScenario } from '../stories/earthquake';
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

interface EarthquakeFrame {
  scenario: EarthquakeScenario;
  t: number;
  u: Float64Array;
  yieldMember?: number;
}

interface TestConsoleProps {
  model: EditorModel;
  modal?: EigenResult;
  buckling?: EigenResult;
  analysisOptions?: AnalysisOptions;
  playing: boolean;
  storyTime: number;
  traffic?: TrafficFrame;
  /** Undefined while playback is active; null means this station has no finite yield limit. */
  trafficYieldCapacity?: number | null;
  envelopeEnabled: boolean;
  onEnvelopeEnabled: (enabled: boolean) => void;
  influenceEnvelope: boolean;
  onInfluenceEnvelope: (enabled: boolean) => void;
  ramp?: RampFrame;
  rampCapacity?: number;
  pushover?: PushoverResult;
  wind?: WindFrame;
  earthquake?: EarthquakeFrame;
  onTogglePlayback: () => void;
  onRestart: () => void;
  onSeekTrafficStation: (station: number) => void;
  onReplayFailure: () => void;
  onReturn: () => void;
}

/** Test-story controls, real playback state, and capacity/failure explanation. */
export function TestConsole({
  model,
  modal,
  buckling,
  analysisOptions = {},
  playing,
  storyTime,
  traffic,
  trafficYieldCapacity,
  envelopeEnabled,
  onEnvelopeEnabled,
  influenceEnvelope,
  onInfluenceEnvelope,
  ramp,
  rampCapacity,
  pushover,
  wind,
  earthquake,
  onTogglePlayback,
  onRestart,
  onSeekTrafficStation,
  onReplayFailure,
  onReturn,
}: TestConsoleProps): React.JSX.Element {
  const story = useEditorStore((state) => state.model.story);
  const setStory = useEditorStore((state) => state.setStory);
  const [influenceKey, setInfluenceKey] = useState('moment-mid');
  const failure = useMemo(() => {
    try {
      return evaluateFailure(model, 1, analysisOptions);
    } catch {
      return undefined;
    }
  }, [analysisOptions, model]);
  const massKg = useMemo(() => {
    try {
      const mesh = buildMesh(model, analysisOptions);
      return mesh.elements.reduce((sum, element) => sum + element.rho * element.A * element.L, 0);
    } catch {
      return 0;
    }
  }, [analysisOptions, model]);
  const referenceLoadN = useMemo(() => {
    const pointLoad = model.loads.points.reduce(
      (sum, point) => sum + Math.hypot(point.fx, point.fy),
      0,
    );
    if (!model.loads.gravity) return pointLoad;
    return pointLoad + massKg * 9.80665;
  }, [massKg, model.loads]);
  const f1 = modal?.values[0] ? modal.values[0]! / (Math.PI * 2) : undefined;
  const capacity = failure?.kind === 'stable' ? failure.capacityFactor : undefined;
  const capacityToWeight =
    capacity && Number.isFinite(capacity) && massKg > 0 && referenceLoadN > 0
      ? (capacity * referenceLoadN) / massKg
      : undefined;
  const frontStation = story.kind === 'traffic' ? storyTime * story.speed : 0;
  const windMarks = modal
    ? Array.from(modal.values.slice(0, 4), (value, index) => ({
        label: `f${index + 1}`,
        value: value / (Math.PI * 2),
      }))
    : [];
  const records = useMemo(() => earthquakeRecords(), []);
  const spectrum = earthquake?.scenario.spectrum;
  const spectrumPeak = spectrum ? spectrum.points[spectrum.peakIndex] : undefined;
  const influenceChoices = useMemo(() => influenceQuantityChoices(model), [model]);
  const influenceQuantity =
    influenceChoices.find((choice) => choice.key === influenceKey)?.quantity ??
    influenceChoices[0]?.quantity;
  const influenceLine = useMemo(() => {
    if (story.kind !== 'traffic' || !influenceQuantity || model.deck.length === 0) return undefined;
    try {
      return computeInfluenceLine(model, influenceQuantity, analysisOptions);
    } catch {
      return undefined;
    }
  }, [analysisOptions, influenceQuantity, model, story.kind]);
  const influenceTrafficEnvelope = useMemo(() => {
    if (!influenceLine || story.kind !== 'traffic') return undefined;
    const axleForce = (Math.max(0, story.weightkN) * 1000) / 2;
    return envelopeFromInfluence(influenceLine, axleForce);
  }, [influenceLine, story]);
  const cableState = useMemo(() => {
    if (!modelHasCables(model)) return undefined;
    try {
      return solveTensionOnly(model, analysisOptions);
    } catch {
      return undefined;
    }
  }, [analysisOptions, model]);

  return (
    <section className="test-console" aria-label="Test stories and capacity">
      <div className="test-console-header">
        <span>Test Console</span>
        <button type="button" onClick={onReturn}>
          Return to Build
        </button>
      </div>
      <div className="story-tabs">
        {(['traffic', 'wind', 'earthquake', 'ramp', 'pushover'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={story.kind === kind ? 'active' : ''}
            onClick={() => {
              if (kind === 'traffic')
                setStory({ kind, weightkN: 300, speed: 12, movingMass: false });
              if (kind === 'wind')
                setStory({
                  kind,
                  pattern: 'sine',
                  amplitudekNm: 2,
                  freqHz: Math.min(5, Math.max(0.05, f1 ?? 1)),
                  zeta: 0.02,
                });
              if (kind === 'earthquake') setStory({ kind, record: 'pulse', scale: 1, zeta: 0.05 });
              if (kind === 'ramp') setStory({ kind });
              if (kind === 'pushover') setStory({ kind });
            }}
          >
            {kind}
          </button>
        ))}
      </div>
      <div className="story-transport">
        <button type="button" className="play-button" onClick={onTogglePlayback}>
          {playing ? 'Pause' : 'Play'} <kbd>Space</kbd>
        </button>
        <button type="button" onClick={onRestart}>
          Restart
        </button>
        <span>
          {story.kind === 'wind' || story.kind === 'earthquake'
            ? `t ${storyTime.toFixed(2)} s`
            : story.kind === 'ramp'
              ? `λ ${(ramp?.factor ?? 0).toFixed(2)}`
              : story.kind === 'pushover'
                ? `H ${((pushover?.collapseBaseShear ?? 0) / 1000).toFixed(1)} kN collapse`
                : `station ${frontStation.toFixed(1)} m`}
        </span>
      </div>
      {story.kind === 'traffic' && (
        <div className="story-fields">
          <label>
            Vehicle {story.weightkN.toFixed(0)} kN
            <input
              type="range"
              min="10"
              max="500"
              step="10"
              value={story.weightkN}
              onChange={(event) => setStory({ ...story, weightkN: Number(event.target.value) })}
            />
          </label>
          <label>
            Speed {story.speed.toFixed(0)} m/s
            <input
              type="range"
              min="5"
              max="30"
              step="1"
              value={story.speed}
              onChange={(event) => setStory({ ...story, speed: Number(event.target.value) })}
            />
          </label>
          <label>
            Truck station {frontStation.toFixed(1)} m
            <input
              aria-label="Truck station"
              type="range"
              min="0"
              max={Math.max(0, traffic?.length ?? 0)}
              step="0.05"
              value={Math.min(Math.max(0, frontStation), Math.max(0, traffic?.length ?? 0))}
              disabled={!traffic || traffic.length === 0 || (story.movingMass && playing)}
              onChange={(event) => onSeekTrafficStation(Number(event.target.value))}
            />
          </label>
          <label className="envelope-toggle">
            <input
              type="checkbox"
              checked={story.movingMass}
              onChange={(event) => setStory({ ...story, movingMass: event.target.checked })}
            />{' '}
            Moving mass
          </label>
          <label className="envelope-toggle">
            <input
              type="checkbox"
              checked={envelopeEnabled}
              onChange={(event) => onEnvelopeEnabled(event.target.checked)}
            />{' '}
            Moment envelope
          </label>
          <label className="envelope-toggle">
            <input
              type="checkbox"
              checked={influenceEnvelope}
              disabled={!envelopeEnabled || model.deck.length === 0}
              onChange={(event) => onInfluenceEnvelope(event.target.checked)}
            />{' '}
            from influence line
          </label>
          <p>
            Two axles, 4 m apart ·{' '}
            {traffic ? `${traffic.length.toFixed(1)} m deck sweep` : 'paint a contiguous deck path'}
            {story.movingMass
              ? ` · moving-mass Newmark (ζ = 2%) — vehicle mass lumped at axle contacts; M updated each step${traffic?.movingMass ? ` · amp ×${traffic.movingMass.amplification.toFixed(2)} vs static at this station` : ''}`
              : ' · quasi-static — enable Moving mass for the honest ~10–30% dynamic-amplification cousin'}
            .
          </p>
          {influenceChoices.length > 0 && (
            <label>
              Influence{' '}
              <select
                aria-label="Influence quantity"
                value={
                  influenceChoices.some((choice) => choice.key === influenceKey)
                    ? influenceKey
                    : influenceChoices[0]!.key
                }
                onChange={(event) => setInfluenceKey(event.target.value)}
              >
                {influenceChoices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {influenceLine && (
            <InfluencePanel
              line={influenceLine}
              trafficEnvelope={influenceTrafficEnvelope}
              station={frontStation}
            />
          )}
        </div>
      )}
      {story.kind === 'wind' && (
        <div className="story-fields">
          <label>
            Pattern{' '}
            <select
              value={story.pattern}
              onChange={(event) =>
                setStory({ ...story, pattern: event.target.value as typeof story.pattern })
              }
            >
              <option value="steady">steady</option>
              <option value="sine">sine</option>
              <option value="gusts">gusts</option>
            </select>
          </label>
          <label>
            Amplitude {story.amplitudekNm.toFixed(1)} kN/m
            <input
              type="range"
              min="0.1"
              max="10"
              step="0.1"
              value={story.amplitudekNm}
              onChange={(event) => setStory({ ...story, amplitudekNm: Number(event.target.value) })}
            />
          </label>
          <label>
            Frequency {story.freqHz.toFixed(2)} Hz
            <input
              list="wind-frequency-marks"
              type="range"
              min="0.05"
              max="5"
              step="0.05"
              value={story.freqHz}
              onChange={(event) => setStory({ ...story, freqHz: Number(event.target.value) })}
            />
          </label>
          <datalist id="wind-frequency-marks">
            {windMarks
              .filter((mark) => mark.value >= 0.05 && mark.value <= 5)
              .map((mark) => (
                <option
                  key={mark.label}
                  value={mark.value.toFixed(2)}
                  label={`${mark.label} ${mark.value.toFixed(2)} Hz`}
                >
                  {mark.label} {mark.value.toFixed(2)} Hz
                </option>
              ))}
          </datalist>
          <label>
            Damping {(story.zeta * 100).toFixed(1)}%
            <input
              type="range"
              min="0.005"
              max="0.1"
              step="0.005"
              value={story.zeta}
              onChange={(event) => setStory({ ...story, zeta: Number(event.target.value) })}
            />
          </label>
          <p>
            Simplified uniform wind field (member-normal 2D pressure)
            {wind?.daf
              ? ` · measured DAF ${wind.daf.ratio.toFixed(2)} at q${wind.daf.mode + 1}`
              : ''}
            .
          </p>
          {model.name === 'Slender deck' && (
            <p className="honesty-note">
              Tacoma Narrows failed in torsional aeroelastic flutter — a 3D phenomenon. This 2D
              preset shows the in-plane bending-resonance cousin only; switch to 3D → preset 5 for
              the St. Venant torsion mode (still not flutter / warping).
            </p>
          )}
          {wind?.resonanceMode !== undefined && (
            <div className="resonance-panel" role="status">
              {wind.yieldMember !== undefined
                ? `Resonance → yield at member ${wind.yieldMember}`
                : `Resonance with mode ${wind.resonanceMode + 1} (${(modal?.values[wind.resonanceMode]! / (Math.PI * 2)).toFixed(2)} Hz)`}
            </div>
          )}
          {wind && <ModeBars coordinates={wind.coordinates} modal={modal} />}
        </div>
      )}
      {story.kind === 'earthquake' && (
        <div className="story-fields">
          <label>
            Record{' '}
            <select
              value={story.record}
              onChange={(event) =>
                setStory({ ...story, record: event.target.value as EarthquakeRecordId })
              }
            >
              {records.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Scale ×{story.scale.toFixed(2)}
            <input
              type="range"
              min="0.25"
              max="3"
              step="0.05"
              value={story.scale}
              onChange={(event) => setStory({ ...story, scale: Number(event.target.value) })}
            />
          </label>
          <label>
            Damping {(story.zeta * 100).toFixed(1)}%
            <input
              type="range"
              min="0.005"
              max="0.1"
              step="0.005"
              value={story.zeta}
              onChange={(event) => setStory({ ...story, zeta: Number(event.target.value) })}
            />
          </label>
          <p>
            Horizontal base excitation F = −M·ι·ü_g(t) ·{' '}
            {earthquake?.scenario.record.note ?? records.find((r) => r.id === story.record)?.note}
          </p>
          {earthquake?.yieldMember !== undefined && (
            <div className="resonance-panel" role="status">
              Yield at member {earthquake.yieldMember} under base motion
            </div>
          )}
          {spectrum && spectrumPeak && (
            <SpectrumPanel spectrum={spectrum} peak={spectrumPeak} f1={f1} />
          )}
        </div>
      )}
      {story.kind === 'ramp' && (
        <div className="story-fields">
          <p>Proportional load ramp: {describeFailure(ramp?.report ?? failure)}</p>
          <p>
            Stops at the exact first limit{' '}
            {rampCapacity && Number.isFinite(rampCapacity)
              ? `λ ${rampCapacity.toFixed(2)}`
              : 'when a stable reference load exists'}{' '}
            · quasi-static sequence — inertia not modeled.
          </p>
          {ramp?.report && ramp.report.kind !== 'stable' && (
            <FailurePanel report={ramp.report} ramp={ramp} onReplay={onReplayFailure} />
          )}
        </div>
      )}
      {story.kind === 'pushover' && (
        <div className="story-fields">
          <p>
            Plastic pushover — hinges when |M| reaches M_p = Z·f_y · bilinear moment-curvature,
            event-to-event.
          </p>
          {pushover ? (
            <PushoverPanel result={pushover} />
          ) : (
            <p>Add lateral point loads to run a pushover curve.</p>
          )}
        </div>
      )}
      {cableState && (
        <div className="cable-banner" role="status">
          Cables: {cableState.activeCables.length} taut · {cableState.slackCables.length} slack
          {cableState.slackCables.length > 0
            ? ` (members ${cableState.slackCables.join(', ')})`
            : ''}
          {cableState.frozen ? ' · iteration frozen' : ` · ${cableState.iterations} iter`}
        </div>
      )}
      <div className="capacity-panel">
        <span>
          {capacity && Number.isFinite(capacity)
            ? `Capacity λ ${capacity.toFixed(2)}`
            : 'Capacity needs a stable loaded model'}
        </span>
        <span>
          {buckling?.values[0]
            ? `Buckling λ ${buckling.values[0]!.toFixed(2)}`
            : 'Buckling: no compression'}
        </span>
        <span>{f1 ? `f₁ ${f1.toFixed(2)} Hz` : 'f₁ unavailable'}</span>
        <span>Mass {(massKg / 1000).toFixed(2)} t</span>
        <span title="Resonance is excluded — it is frequency- not amplitude-governed. See wind story for the DAF meter.">
          {capacityToWeight
            ? `Capacity/weight ${capacityToWeight.toFixed(2)} kN/t`
            : 'Capacity/weight needs a reference load'}
        </span>
        {story.kind === 'traffic' && <span>{trafficCapacityLabel(trafficYieldCapacity)}</span>}
      </div>
    </section>
  );
}

function PushoverPanel({ result }: { result: PushoverResult }): React.JSX.Element {
  const maxShear = Math.max(...result.points.map((point) => point.baseShear), 1e-9);
  const maxDisp = Math.max(...result.points.map((point) => point.roofDisp), 1e-12);
  const path = result.points
    .map((point, index) => {
      const x = (point.roofDisp / maxDisp) * 300 + 10;
      const y = 64 - (point.baseShear / maxShear) * 56;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className="influence-panel" aria-label="Pushover curve">
      <div className="spectrum-header">
        <span>Base shear vs roof displacement</span>
        <span>
          {(result.collapseBaseShear / 1000).toFixed(1)} kN · {result.outcome}
        </span>
      </div>
      <svg viewBox="0 0 320 72" className="spectrum-chart" role="img" aria-label="Pushover curve">
        <path d={path} fill="none" stroke="#2456a4" strokeWidth="1.6" />
        {result.points.map((point, index) => {
          const x = (point.roofDisp / maxDisp) * 300 + 10;
          const y = 64 - (point.baseShear / maxShear) * 56;
          return (
            <circle
              key={index}
              cx={x}
              cy={y}
              r={index === result.points.length - 1 ? 3 : 2}
              fill={index === result.points.length - 1 ? '#c0392b' : '#2456a4'}
            />
          );
        })}
      </svg>
      <p className="honesty-note">
        {result.hinges.length} plastic hinge{result.hinges.length === 1 ? '' : 's'}
        {result.hinges.length > 0
          ? ` · last at member ${result.hinges[result.hinges.length - 1]!.memberId}${result.hinges[result.hinges.length - 1]!.end}`
          : ''}
        · quasi-static, no geometric nonlinearity.
      </p>
    </div>
  );
}

function InfluencePanel({
  line,
  trafficEnvelope,
  station,
}: {
  line: InfluenceLine;
  trafficEnvelope?: { maxAbs: number; criticalStation: number };
  station: number;
}): React.JSX.Element {
  const peak = Math.max(...line.samples.map((sample) => Math.abs(sample.value)), 1e-12);
  const points = line.samples
    .map((sample, index) => {
      const x = line.length <= 0 ? 10 : (sample.station / line.length) * 300 + 10;
      const y = 36 - (sample.value / peak) * 28;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const markerX =
    line.length <= 0 ? 10 : (Math.min(Math.max(0, station), line.length) / line.length) * 300 + 10;
  return (
    <div className="influence-panel" aria-label="Influence line">
      <div className="spectrum-header">
        <span>Influence line · unit downward load</span>
        <span>
          peak {formatInfluence(line.peak.value)} at {line.peak.station.toFixed(1)} m
        </span>
      </div>
      <svg
        viewBox="0 0 320 72"
        className="spectrum-chart"
        role="img"
        aria-label="Influence line along the deck"
      >
        <line x1="10" x2="310" y1="36" y2="36" stroke="rgba(26,29,33,0.25)" strokeWidth="1" />
        <path d={points} fill="none" stroke="#2456a4" strokeWidth="1.6" />
        <line
          x1={markerX}
          x2={markerX}
          y1="8"
          y2="64"
          stroke="#c0392b"
          strokeDasharray="2 2"
          strokeWidth="1"
        />
      </svg>
      <p className="honesty-note">
        Unit-load sweep along the painted deck
        {trafficEnvelope
          ? ` · two-axle envelope |η|max ${formatInfluence(trafficEnvelope.maxAbs)} at front ${trafficEnvelope.criticalStation.toFixed(1)} m`
          : ''}
        .
      </p>
    </div>
  );
}

function influenceQuantityChoices(
  model: EditorModel,
): Array<{ key: string; label: string; quantity: InfluenceQuantity }> {
  if (model.deck.length === 0) return [];
  const choices: Array<{ key: string; label: string; quantity: InfluenceQuantity }> = [];
  for (const memberId of model.deck) {
    choices.push({
      key: `moment-${memberId}`,
      label: `M mid · member ${memberId}`,
      quantity: { kind: 'moment', memberId, at: 'mid' },
    });
    choices.push({
      key: `axial-${memberId}`,
      label: `N · member ${memberId}`,
      quantity: { kind: 'axial', memberId },
    });
  }
  for (const support of model.supports) {
    choices.push({
      key: `reaction-${support.node}`,
      label: `R_y · node ${support.node}`,
      quantity: { kind: 'reaction', nodeId: support.node, component: 'fy' },
    });
  }
  return choices;
}

function formatInfluence(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3);
  return value.toExponential(2);
}

function SpectrumPanel({
  spectrum,
  peak,
  f1,
}: {
  spectrum: NonNullable<EarthquakeFrame['scenario']['spectrum']>;
  peak: { freqHz: number; sa: number };
  f1?: number;
}): React.JSX.Element {
  const maxSa = Math.max(...spectrum.points.map((point) => point.sa), 1e-9);
  return (
    <div className="spectrum-panel" aria-label="Response spectrum">
      <div className="spectrum-header">
        <span>Sa spectrum (ζ {(spectrum.zeta * 100).toFixed(0)}%)</span>
        <span>
          peak {peak.sa.toFixed(2)} m/s² at {peak.freqHz.toFixed(2)} Hz
        </span>
      </div>
      <svg
        viewBox="0 0 320 72"
        className="spectrum-chart"
        role="img"
        aria-label="Pseudo-acceleration spectrum 0.1 to 10 Hz"
      >
        {spectrum.points.map((point, index) => {
          const x = (index / Math.max(1, spectrum.points.length - 1)) * 300 + 10;
          const h = (point.sa / maxSa) * 56;
          const active = index === spectrum.peakIndex;
          return (
            <rect
              key={point.freqHz}
              x={x}
              y={64 - h}
              width={3.2}
              height={h}
              fill={active ? '#c0392b' : '#2456a4'}
              opacity={active ? 1 : 0.75}
            />
          );
        })}
        {f1 !== undefined &&
          f1 >= 0.1 &&
          f1 <= 10 &&
          (() => {
            const t = Math.log(f1 / 0.1) / Math.log(10 / 0.1);
            const x = t * 300 + 10;
            return (
              <line
                x1={x}
                x2={x}
                y1={8}
                y2={64}
                stroke="#1a1d21"
                strokeDasharray="2 2"
                strokeWidth="1"
              />
            );
          })()}
      </svg>
      <p className="honesty-note">
        SDOF pseudo-acceleration sweep 0.1–10 Hz — dashed mark is f₁ when in range.
      </p>
    </div>
  );
}

function ModeBars({
  coordinates,
  modal,
}: {
  coordinates: Float64Array;
  modal?: EigenResult;
}): React.JSX.Element | null {
  if (!modal || coordinates.length === 0) return null;
  const maximum = Math.max(...Array.from(coordinates, (value) => Math.abs(value)), 1e-12);
  return (
    <div className="mode-energy" aria-label="Modal response coordinates">
      {Array.from(coordinates.slice(0, 4), (value, index) => (
        <div key={index}>
          <span>q{index + 1}</span>
          <i style={{ width: `${Math.max(3, (Math.abs(value) / maximum) * 100)}%` }} />
          <b>{value.toExponential(1)}</b>
        </div>
      ))}
    </div>
  );
}

function FailurePanel({
  report,
  ramp,
  onReplay,
}: {
  report: Exclude<FailureReport, { kind: 'stable' }>;
  ramp: RampFrame;
  onReplay: () => void;
}): React.JSX.Element {
  return (
    <div className="failure-panel" role="status">
      <strong>Failure: {describeFailure(report)}</strong>
      <button type="button" onClick={onReplay}>
        Replay failure
      </button>
      <details>
        <summary>Why this happened</summary>
        <p className="failure-formula">{failureFormula(report)}</p>
        <p>{failureWhy(report)}</p>
        {ramp.cascade && (
          <ol>
            {ramp.cascade.steps.map((step, index) => (
              <li key={`${step.memberId}-${index}`}>{step.detail}</li>
            ))}
          </ol>
        )}
        {ramp.cascade?.steps.length === 0 && (
          <p>No additional cascade step was needed to identify the first limit.</p>
        )}
      </details>
    </div>
  );
}

function failureFormula(failure: Exclude<FailureReport, { kind: 'stable' }>): string {
  if (failure.kind === 'mechanism')
    return `Kff is singular at node ${failure.nodeId}: no constrained equilibrium exists.`;
  if (failure.kind === 'yield')
    return `U = |N/A ± Mc/I| / fy = ${failure.utilization.toFixed(2)} at λ = ${failure.loadFactor.toFixed(2)}.`;
  if (failure.kind === 'buckling')
    return failure.governs === 'member' &&
      failure.memberN !== undefined &&
      failure.memberNCr !== undefined
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
  if (failure.kind === 'stable')
    return `governed by ${failure.governedBy} at λ ${formatFinite(failure.capacityFactor)}.`;
  if (failure.kind === 'mechanism') return `mechanism at node ${failure.nodeId}.`;
  if (failure.kind === 'yield')
    return `yield at member ${failure.memberId}${failure.stationM === undefined ? '' : ` at ${failure.stationM.toFixed(2)} m`} (U ${failure.utilization.toFixed(2)}).`;
  if (failure.kind === 'buckling')
    return `${failure.governs} buckling at member ${failure.memberId} (λ ${failure.lambdaCr.toFixed(2)}).`;
  return `resonance with mode ${failure.mode + 1} at ${failure.freqHz.toFixed(2)} Hz.`;
}

function failureWhy(failure: Exclude<FailureReport, { kind: 'stable' }>): string {
  if (failure.kind === 'mechanism')
    return `The constrained stiffness matrix has a free motion at node ${failure.nodeId}; a load factor cannot create a stable equilibrium.`;
  if (failure.kind === 'yield')
    return `Member ${failure.memberId} reaches combined stress utilization ${failure.utilization.toFixed(2)}${failure.stationM === undefined ? '' : ` at ${failure.stationM.toFixed(2)} m`} at λ ${failure.loadFactor.toFixed(2)}.`;
  if (failure.kind === 'buckling')
    return failure.governs === 'member' &&
      failure.memberN !== undefined &&
      failure.memberNCr !== undefined
      ? `Member ${failure.memberId} compression ${formatForce(failure.memberN)} reaches its Euler capacity ${formatForce(failure.memberNCr)}.`
      : `The global geometric-stiffness eigenproblem gives λcr ${failure.lambdaCr.toFixed(2)} for the compression pattern, led by member ${failure.memberId}.`;
  return `Forcing is near mode ${failure.mode + 1} at ${failure.freqHz.toFixed(2)} Hz; the measured modal envelope over five cycles and damping threshold classify the response as resonance.`;
}

function formatForce(value: number): string {
  return `${(value / 1000).toFixed(1)} kN`;
}
function formatFinite(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}
