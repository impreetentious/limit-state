'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { StructureCanvas } from '../canvas/structure-canvas';
import { analyzeStaticModel, deformationDisplay } from '../fem/statics';
import type { EigenResult } from '../fem/types';
import { PRESETS } from '../presets/scenes';
import { decodeModel, encodeModel } from '../share/serialize';
import { inspectStability } from '../state/stability';
import { MEMBER_HARD_LIMIT, MEMBER_SOFT_LIMIT, type EditorTool, useEditorStore } from '../state/editor-store';
import { analyzeRamp, rampCapacity } from '../stories/ramp';
import { analyzeTrafficAt, mergeMomentEnvelope, prepareTraffic, trafficYieldWeightAt } from '../stories/traffic';
import {
  detectResonance,
  initialWindState,
  measuredDaf,
  modalCoordinates,
  prepareWind,
  stepWind,
  windReferenceCoordinates,
  windUtilization,
  type WindScenario,
} from '../stories/wind';
import type { EigenWorkerResponse } from '../workers/eigen.worker';
import { Inspector } from './inspector';
import { TestConsole } from './test-console';

const TOOLS: Array<{ id: EditorTool; label: string; key: string; description: string }> = [
  { id: 'select', label: 'Select', key: 'V', description: 'Inspect a node or member' },
  { id: 'node', label: 'Node', key: 'N', description: 'Place a grid-snapped node' },
  { id: 'member', label: 'Member', key: 'M', description: 'Connect two nodes' },
  { id: 'support', label: 'Support', key: 'S', description: 'Cycle pin, roller, fixed' },
  { id: 'load', label: 'Load', key: 'L', description: 'Add a 10 kN point load' },
  { id: 'deck', label: 'Deck', key: 'D', description: 'Paint a traffic path' },
  { id: 'delete', label: 'Delete', key: '⌫', description: 'Remove a node or member' },
];

export function EditorApp(): React.JSX.Element {
  const model = useEditorStore((state) => state.model);
  const mode = useEditorStore((state) => state.mode);
  const tool = useEditorStore((state) => state.tool);
  const gridSnap = useEditorStore((state) => state.gridSnap);
  const stability = useEditorStore((state) => state.stability);
  const notice = useEditorStore((state) => state.notice);
  const resultDiagram = useEditorStore((state) => state.resultDiagram);
  const showDeformed = useEditorStore((state) => state.showDeformed);
  const setMode = useEditorStore((state) => state.setMode);
  const setTool = useEditorStore((state) => state.setTool);
  const setGridSnap = useEditorStore((state) => state.setGridSnap);
  const setModelName = useEditorStore((state) => state.setModelName);
  const loadModel = useEditorStore((state) => state.loadModel);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const reset = useEditorStore((state) => state.reset);
  const setStability = useEditorStore((state) => state.setStability);
  const setNotice = useEditorStore((state) => state.setNotice);
  const setResultDiagram = useEditorStore((state) => state.setResultDiagram);
  const setShowDeformed = useEditorStore((state) => state.setShowDeformed);
  const baseAnalysis = useMemo(() => analyzeStaticModel(model), [model]);
  const requestId = useRef(0);
  const [eigen, setEigen] = useState<EigenUiState>({ kind: 'idle' });
  const [selectedMode, setSelectedMode] = useState(0);
  const [modeFamily, setModeFamily] = useState<'modal' | 'buckling'>('modal');
  const [modePhase, setModePhase] = useState(1);
  const [storyPlaying, setStoryPlaying] = useState(false);
  const [storyTime, setStoryTime] = useState(0);
  const [momentEnvelope, setMomentEnvelope] = useState<Map<number, number>>(new Map());
  const [envelopeEnabled, setEnvelopeEnabled] = useState(false);
  const [windFrame, setWindFrame] = useState<WindFrame>();
  const [failureReplay, setFailureReplay] = useState(0);
  const [failurePhase, setFailurePhase] = useState<number>();
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (baseAnalysis.kind !== 'stable') {
      setEigen({ kind: 'idle' });
      return;
    }
    const id = ++requestId.current;
    const worker = new Worker(new URL('../workers/eigen.worker.ts', import.meta.url));
    setEigen({ kind: 'loading' });
    worker.onmessage = (event: MessageEvent<EigenWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.ok) {
        setEigen({ kind: 'ready', modal: response.modal, buckling: response.buckling });
        setSelectedMode(0);
      } else {
        setEigen({ kind: 'error', message: response.message });
      }
    };
    worker.onerror = () => setEigen({ kind: 'error', message: 'Eigen worker could not start.' });
    const axialForces = new Float64Array(baseAnalysis.mesh.elements.length);
    for (let index = 0; index < axialForces.length; index++) axialForces[index] = baseAnalysis.result.elementForces[index * 5]!;
    worker.postMessage({ id, mesh: baseAnalysis.mesh, elementN: axialForces, nModes: 8 });
    return () => worker.terminate();
  }, [baseAnalysis]);

  const activeEigen = eigen.kind === 'ready' ? (modeFamily === 'modal' ? eigen.modal : eigen.buckling) : undefined;
  const activeFrequency = modeFamily === 'modal' ? activeEigen?.values[selectedMode] : undefined;
  const nativeAnimationHz = activeFrequency ? activeFrequency / (Math.PI * 2) : modeFamily === 'buckling' ? 0.5 : undefined;
  const animationHz = nativeAnimationHz && nativeAnimationHz > 2 ? nativeAnimationHz / 4 : nativeAnimationHz;
  useEffect(() => {
    if (animationHz === undefined || reducedMotion) {
      setModePhase(1);
      return;
    }
    let frame = 0;
    const tick = (milliseconds: number) => {
      setModePhase(Math.sin((milliseconds / 1000) * Math.PI * 2 * animationHz));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [animationHz, reducedMotion]);
  const modeGhost = activeEigen && activeEigen.values[selectedMode] !== undefined
    ? { vectors: activeEigen.vectors, mode: selectedMode, phase: modePhase }
    : undefined;

  const trafficScenario = useMemo(() => {
    if (model.story.kind !== 'traffic' || mode !== 'test') return undefined;
    try { return prepareTraffic(model); } catch { return undefined; }
  }, [mode, model]);
  const trafficFrame = useMemo(
    () => trafficScenario && model.story.kind === 'traffic' ? analyzeTrafficAt(trafficScenario, storyTime * model.story.speed) : undefined,
    [model.story, storyTime, trafficScenario],
  );
  const capacity = useMemo(() => model.story.kind === 'ramp' ? rampCapacity(model) : undefined, [model]);
  const rampFactor = model.story.kind === 'ramp' && capacity !== undefined
    ? Math.min(capacity, Math.max(0.001, storyTime * capacity / 8))
    : 0.001;
  const rampFrame = useMemo(
    () => model.story.kind === 'ramp' && mode === 'test' ? analyzeRamp(model, rampFactor, storyTime >= 8) : undefined,
    [mode, model, rampFactor, storyTime],
  );
  const analysis = trafficFrame?.analysis ?? rampFrame?.analysis ?? baseAnalysis;
  const deformation = analysis.kind === 'stable' ? deformationDisplay(analysis.mesh, analysis.result.u, 44) : null;
  const windScenario = useMemo(() => model.story.kind === 'wind' ? prepareWind(model) : undefined, [model]);
  const modal = eigen.kind === 'ready' ? eigen.modal : undefined;
  const trafficDuration = trafficFrame && model.story.kind === 'traffic'
    ? (trafficFrame.length + 4) / Math.max(0.1, model.story.speed)
    : undefined;
  const trafficYieldCapacity = useMemo(
    () => !storyPlaying && trafficScenario && model.story.kind === 'traffic'
      ? trafficYieldWeightAt(trafficScenario, storyTime * model.story.speed) ?? null
      : undefined,
    [model.story, storyPlaying, storyTime, trafficScenario],
  );
  const failureReport = rampFrame?.report && rampFrame.report.kind !== 'stable' ? rampFrame.report : undefined;
  const failureKey = failureReport ? `${failureReport.kind}-${rampFrame?.factor ?? 0}` : undefined;

  useEffect(() => {
    setStoryPlaying(false);
    setStoryTime(0);
    setMomentEnvelope(new Map());
    setWindFrame(undefined);
  }, [model]);

  useEffect(() => {
    if (!failureKey) {
      setFailurePhase(undefined);
      return;
    }
    if (reducedMotion) {
      setFailurePhase(1);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      setFailurePhase(Math.min(1, (now - started) / 1200));
      if (now - started < 1200) frame = window.requestAnimationFrame(tick);
    };
    setFailurePhase(0);
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [failureKey, failureReplay, reducedMotion]);

  useEffect(() => {
    if (mode !== 'test' || !storyPlaying || model.story.kind === 'wind') return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(0.1, Math.max(0, (now - previous) / 1000));
      previous = now;
      setStoryTime((current) => {
        const next = current + elapsed;
        if (model.story.kind === 'traffic' && trafficDuration && next >= trafficDuration) {
          setMomentEnvelope(new Map());
          return 0;
        }
        if (model.story.kind === 'ramp' && capacity !== undefined && next >= 8) {
          setStoryPlaying(false);
          return 8;
        }
        return next;
      });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [capacity, mode, model.story.kind, storyPlaying, trafficDuration]);

  useEffect(() => {
    if (!envelopeEnabled || !trafficFrame) return;
    setMomentEnvelope((previous) => mergeMomentEnvelope(previous, trafficFrame.analysis));
  }, [envelopeEnabled, trafficFrame]);

  useEffect(() => {
    if (mode !== 'test' || !storyPlaying || !windScenario || !modal) return;
    const initial = initialWindState(windScenario, modal);
    if (!initial) return;
    const initialCoordinates = modalCoordinates(windScenario.mesh, modal, initial.u, windScenario.mass);
    const referenceCoordinates = windReferenceCoordinates(windScenario, modal);
    let current = initial;
    let history: number[] = [];
    let frame = 0;
    const tick = () => {
      current = stepWind(windScenario, current);
      const rawCoordinates = modalCoordinates(windScenario.mesh, modal, current.u, windScenario.mass);
      const coordinates = new Float64Array(rawCoordinates.length);
      for (let index = 0; index < coordinates.length; index++) coordinates[index] = rawCoordinates[index]! - initialCoordinates[index]!;
      const nearestMode = nearestFrequencyMode(modal, windScenario.model.freqHz);
      const samplesPerCycle = Math.max(1, Math.ceil(1 / (windScenario.dt * 4 * Math.max(0.05, windScenario.model.freqHz))));
      history = [...history, Math.abs(coordinates[nearestMode] ?? 0)].slice(-samplesPerCycle * 5);
      const resonanceMode = detectResonance(windScenario.model.freqHz, modal, windScenario.model.zeta, history, samplesPerCycle);
      const daf = measuredDaf(coordinates, referenceCoordinates);
      const yieldMember = governingYieldMember(windUtilization(windScenario, current.u));
      setWindFrame({ scenario: windScenario, t: current.t, u: current.u, coordinates, daf, resonanceMode, yieldMember });
      setStoryTime(current.t);
      frame = window.requestAnimationFrame(tick);
    };
    setWindFrame({ scenario: windScenario, t: initial.t, u: initial.u, coordinates: new Float64Array(initialCoordinates.length), daf: measuredDaf(new Float64Array(initialCoordinates.length), referenceCoordinates) });
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [modal, mode, storyPlaying, windScenario]);

  useEffect(() => {
    let cancelled = false;
    const hash = window.location.hash;
    if (!hash.startsWith('#m=') && !hash.startsWith('#mu=')) return;
    void decodeModel(hash).then((shared) => {
      if (!cancelled) loadModel(shared);
    }).catch(() => {
      if (!cancelled) setNotice('This share URL could not be decoded.');
    });
    return () => { cancelled = true; };
  }, [loadModel, setNotice]);

  const shareModel = async () => {
    try {
      const hash = await encodeModel(model);
      window.history.replaceState(null, '', hash);
      await navigator.clipboard?.writeText(window.location.href);
      setNotice('Share link copied — the model stays entirely in the URL.');
    } catch {
      setNotice('Share link could not be encoded.');
    }
  };

  useEffect(() => {
    setStability({ kind: 'checking', message: 'Checking stability…' });
    const timer = window.setTimeout(() => setStability(inspectStability(model)), 300);
    return () => window.clearTimeout(timer);
  }, [model, setStability]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (event.key === ' ') {
        if (mode === 'test') {
          event.preventDefault();
          setStoryPlaying((playing) => !playing);
        }
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') { setTool('delete'); return; }
      const matching = TOOLS.find((candidate) => candidate.key.toLowerCase() === event.key.toLowerCase());
      if (matching) setTool(matching.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, redo, setTool, undo]);

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>△</span><span>Limit State</span></div>
        <input className="model-name" aria-label="Model name" value={model.name} onChange={(event) => setModelName(event.target.value)} />
        <div className="topbar-actions">
          <div className="mode-switch" aria-label="Mode">
            <button type="button" className={mode === 'build' ? 'active' : ''} onClick={() => setMode('build')}>Build</button>
            <button type="button" className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}>Test</button>
          </div>
          <select className="preset-menu" aria-label="Presets" defaultValue="" onChange={(event) => {
            const preset = PRESETS.find((candidate) => candidate.id === event.target.value);
            if (preset) loadModel(preset.model);
            event.currentTarget.value = '';
          }}>
            <option value="" disabled>Presets</option>
            {PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          <button type="button" className="quiet-button" onClick={() => void shareModel()}>Share</button>
          <button type="button" className="quiet-button" onClick={reset}>Blank grid</button>
        </div>
      </header>
      <section className="editor-workspace">
        <nav className="tool-rail" aria-label="Build tools">
          <span className="rail-label">Tools</span>
          {TOOLS.map((candidate) => <button key={candidate.id} type="button" className={tool === candidate.id ? 'tool active' : 'tool'} title={`${candidate.description} (${candidate.key})`} onClick={() => setTool(candidate.id)}><span>{candidate.label}</span><kbd>{candidate.key}</kbd></button>)}
          <div className="rail-bottom">
            <label className="snap-toggle"><input type="checkbox" checked={gridSnap} onChange={(event) => setGridSnap(event.target.checked)} /> Snap 0.5 m</label>
            <button type="button" className="history-button" onClick={undo}>Undo <kbd>⌘Z</kbd></button>
            <button type="button" className="history-button" onClick={redo}>Redo <kbd>⇧⌘Z</kbd></button>
          </div>
        </nav>
        <section className="canvas-panel" aria-label="Structure workspace">
          <StructureCanvas
            analysis={analysis}
            diagram={resultDiagram}
            showDeformed={showDeformed}
            modeGhost={modeGhost}
            trafficAxles={trafficFrame?.axles}
            momentEnvelope={envelopeEnabled ? momentEnvelope : undefined}
            dynamicDisplacement={windFrame?.u}
            failureCinematic={failurePhase !== undefined && rampFrame?.analysis.kind === 'stable'
              ? { u: rampFrame.analysis.result.u, phase: failurePhase, reducedMotion }
              : undefined}
          />
          <div className={`lint-badge lint-${stability.kind}`}>{stability.message}</div>
          {notice && <div className="canvas-notice" role="status">{notice}</div>}
          {analysis.kind === 'stable' && <div className="result-controls" aria-label="Static result display">
            {(['none', 'axial', 'shear', 'moment'] as const).map((diagram) => <button key={diagram} type="button" className={resultDiagram === diagram ? 'active' : ''} onClick={() => setResultDiagram(diagram)}>{diagram === 'none' ? 'Results' : diagram[0]!.toUpperCase() + diagram.slice(1)}</button>)}
            <label><input type="checkbox" checked={showDeformed} onChange={(event) => setShowDeformed(event.target.checked)} /> Deformed</label>
          </div>}
          {deformation && showDeformed && deformation.maxMeters > 0 && <div className="deformation-badge">deformation ×{formatScale(deformation.scale)} — true max {formatLength(deformation.maxMeters)}</div>}
          {windFrame && <div className="dynamic-badge">Newmark response — display scale ×{formatScale(deformationDisplay(windFrame.scenario.mesh, windFrame.u, 44).scale)} · simplified uniform wind field (member-normal 2D pressure)</div>}
          {failurePhase !== undefined && <div className="failure-cinematic-badge">failure animation ×{reducedMotion ? 'static' : formatScale(0.25 + failurePhase * 0.75)} — illustrative, computed onset and mechanism</div>}
          {model.members.length >= MEMBER_SOFT_LIMIT && <div className="member-limit-badge">{model.members.length}/{MEMBER_HARD_LIMIT} members — performance warning at {MEMBER_SOFT_LIMIT}; hard cap {MEMBER_HARD_LIMIT}</div>}
          {analysis.kind === 'stable' && <div className="eigen-panel" aria-live="polite">
            <span>Modal + Buckling</span>
            {eigen.kind === 'loading' && <p>Solving in worker…</p>}
            {eigen.kind === 'error' && <p className="eigen-error">{eigen.message}</p>}
            {eigen.kind === 'ready' && <>
              <div className="mode-family" aria-label="Mode shape family">
                <button type="button" className={modeFamily === 'modal' ? 'active' : ''} onClick={() => { setModeFamily('modal'); setSelectedMode(0); }}>Modal</button>
                <button type="button" className={modeFamily === 'buckling' ? 'active' : ''} onClick={() => { setModeFamily('buckling'); setSelectedMode(0); }}>Buckling</button>
              </div>
              <div className="mode-list" aria-label="Animated mode shapes">
                {Array.from((modeFamily === 'modal' ? eigen.modal : eigen.buckling).values, (value, index) => <button key={index} type="button" className={selectedMode === index ? 'active' : ''} onClick={() => setSelectedMode(index)}>{modeFamily === 'modal' ? `f${index + 1} ${(value / (Math.PI * 2)).toFixed(2)} Hz` : `λ${index + 1} ${value.toFixed(2)}`}</button>)}
              </div>
              <p>{modeFamily === 'modal'
                ? `mode shape normalized — ${reducedMotion ? 'static (reduced motion)' : `animating at ${(animationHz ?? 0).toFixed(2)} Hz${nativeAnimationHz && nativeAnimationHz > 2 ? ' (display slowed ×4)' : ''}`}`
                : `buckling mode normalized — ${reducedMotion ? 'static (reduced motion)' : 'illustrative animation, not displacement'}`}</p>
              <p>{eigen.buckling.values[0] ? `λcr ${eigen.buckling.values[0]!.toFixed(2)} × reference load` : 'No buckling under this load direction.'}</p>
            </>}
          </div>}
          {mode === 'test' && <TestConsole
            model={model}
            modal={modal}
            buckling={eigen.kind === 'ready' ? eigen.buckling : undefined}
            playing={storyPlaying}
            storyTime={storyTime}
            traffic={trafficFrame}
            trafficYieldCapacity={trafficYieldCapacity}
            envelopeEnabled={envelopeEnabled}
            onEnvelopeEnabled={setEnvelopeEnabled}
            ramp={rampFrame}
            rampCapacity={capacity}
            wind={windFrame}
            onTogglePlayback={() => setStoryPlaying((playing) => !playing)}
            onRestart={() => { setStoryTime(0); setMomentEnvelope(new Map()); setWindFrame(undefined); setStoryPlaying(false); }}
            onSeekTrafficStation={(station) => {
              if (model.story.kind !== 'traffic') return;
              setStoryPlaying(false);
              setStoryTime(station / Math.max(0.1, model.story.speed));
            }}
            onReplayFailure={() => { setStoryPlaying(false); setStoryTime(8); setFailureReplay((value) => value + 1); }}
            onReturn={() => setMode('build')}
          />}
        </section>
        <Inspector />
      </section>
    </main>
  );
}

type EigenUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; modal: EigenResult; buckling: EigenResult };

interface WindFrame {
  scenario: WindScenario;
  t: number;
  u: Float64Array;
  coordinates: Float64Array;
  daf?: { mode: number; ratio: number };
  resonanceMode?: number;
  yieldMember?: number;
}

function nearestFrequencyMode(modal: EigenResult, frequency: number): number {
  let nearest = 0;
  let difference = Infinity;
  for (let index = 0; index < modal.values.length; index++) {
    const candidate = Math.abs(modal.values[index]! / (Math.PI * 2) - frequency);
    if (candidate < difference) {
      difference = candidate;
      nearest = index;
    }
  }
  return nearest;
}

function governingYieldMember(utilization: ReadonlyMap<number, number>): number | undefined {
  let member: number | undefined;
  let maximum = 1;
  for (const [id, value] of utilization) {
    if (value >= maximum) {
      maximum = value;
      member = id;
    }
  }
  return member;
}

function formatScale(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

function formatLength(value: number): string {
  if (value < 0.00001) return `${(value * 1_000_000).toFixed(2)} µm`;
  return value < 0.01 ? `${(value * 1000).toFixed(2)} mm` : `${value.toFixed(3)} m`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}
