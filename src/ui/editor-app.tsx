'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CHALLENGES } from '../challenges/catalog';
import { StructureCanvas } from '../canvas/structure-canvas';
import { StructureCanvas3d } from '../canvas/structure-canvas-3d';
import { sectionDepth } from '../fem/materials';
import { analyzeStaticModel, deformationDisplay } from '../fem/statics';
import { analyzeStaticModel3d, buckling3d, deformationDisplay3d, modal3d } from '../fem/space';
import type { EditorModel, EigenResult } from '../fem/types';
import { PRESETS } from '../presets/scenes';
import { DEMOS_3D } from '../presets/scenes3d';
import { useEditorStore3d, type EditorTool3d } from '../state/editor-store-3d';
import { decodeModel, encodeModel } from '../share/serialize';
import { inspectStability } from '../state/stability';
import { MEMBER_HARD_LIMIT, MEMBER_SOFT_LIMIT, type EditorTool, useEditorStore } from '../state/editor-store';
import { analyzeRamp, rampCapacity } from '../stories/ramp';
import { analyzeTrafficAt, initialMovingMassState, mergeMomentEnvelope, prepareTraffic, stepMovingMassTraffic, trafficYieldWeightAt, type TrafficFrame } from '../stories/traffic';
import { memberMomentEnvelopeFromInfluence } from '../fem/influence';
import { runPushover } from '../fem/pushover';
import {
  earthquakeUtilization,
  initialEarthquakeState,
  prepareEarthquake,
  stepEarthquake,
  type EarthquakeScenario,
} from '../stories/earthquake';
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
import { ChallengePanel } from './challenge-panel';
import { Inspector } from './inspector';
import { TestConsole } from './test-console';
import Link from 'next/link';

const TOOLS: Array<{ id: EditorTool; label: string; key: string; description: string }> = [
  { id: 'select', label: 'Select', key: 'V', description: 'Inspect a node or member' },
  { id: 'node', label: 'Node', key: 'N', description: 'Place a grid-snapped node' },
  { id: 'member', label: 'Member', key: 'M', description: 'Connect two nodes' },
  { id: 'support', label: 'Support', key: 'S', description: 'Cycle pin, roller, fixed' },
  { id: 'load', label: 'Load', key: 'L', description: 'Add a 10 kN point load' },
  { id: 'deck', label: 'Deck', key: 'D', description: 'Paint a traffic path' },
  { id: 'delete', label: 'Delete', key: '⌫', description: 'Remove a node or member' },
];

const TOOLS_3D: Array<{ id: EditorTool3d; label: string; key: string }> = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'node', label: 'Node', key: 'N' },
  { id: 'member', label: 'Member', key: 'M' },
  { id: 'support', label: 'Support', key: 'S' },
  { id: 'load', label: 'Load', key: 'L' },
  { id: 'delete', label: 'Delete', key: '⌫' },
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
  const shearFlexible = useEditorStore((state) => state.shearFlexible);
  const secondOrder = useEditorStore((state) => state.secondOrder);
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
  const setShearFlexible = useEditorStore((state) => state.setShearFlexible);
  const setSecondOrder = useEditorStore((state) => state.setSecondOrder);
  const activeChallengeId = useEditorStore((state) => state.activeChallengeId);
  const setActiveChallenge = useEditorStore((state) => state.setActiveChallenge);
  const analysisOptions = useMemo(() => ({ shearFlexible, secondOrder }), [secondOrder, shearFlexible]);
  const baseAnalysis = useMemo(() => analyzeStaticModel(model, analysisOptions), [analysisOptions, model]);
  const stockyMembers = useMemo(() => stockyMemberIds(model), [model]);
  const requestId = useRef(0);
  const [eigen, setEigen] = useState<EigenUiState>({ kind: 'idle' });
  const [selectedMode, setSelectedMode] = useState(0);
  const [modeFamily, setModeFamily] = useState<'modal' | 'buckling'>('modal');
  const [modePhase, setModePhase] = useState(1);
  const [storyPlaying, setStoryPlaying] = useState(false);
  const [storyTime, setStoryTime] = useState(0);
  const [momentEnvelope, setMomentEnvelope] = useState<Map<number, number>>(new Map());
  const [envelopeEnabled, setEnvelopeEnabled] = useState(false);
  const [influenceEnvelope, setInfluenceEnvelope] = useState(false);
  const [windFrame, setWindFrame] = useState<WindFrame>();
  const [earthquakeFrame, setEarthquakeFrame] = useState<EarthquakeFrame>();
  const [movingMassFrame, setMovingMassFrame] = useState<TrafficFrame>();
  const [failureReplay, setFailureReplay] = useState(0);
  const [failurePhase, setFailurePhase] = useState<number>();
  const [viewDimension, setViewDimension] = useState<'2d' | '3d'>('2d');
  const reducedMotion = usePrefersReducedMotion();

  const model3d = useEditorStore3d((s) => s.model);
  const tool3d = useEditorStore3d((s) => s.tool);
  const workplane = useEditorStore3d((s) => s.workplane);
  const selection3d = useEditorStore3d((s) => s.selection);
  const memberStart = useEditorStore3d((s) => s.memberStart);
  const notice3d = useEditorStore3d((s) => s.notice);
  const setTool3d = useEditorStore3d((s) => s.setTool);
  const setWorkplane = useEditorStore3d((s) => s.setWorkplane);
  const loadModel3d = useEditorStore3d((s) => s.loadModel);
  const reset3d = useEditorStore3d((s) => s.reset);
  const addNodeAt = useEditorStore3d((s) => s.addNodeAt);
  const addMemberBetween = useEditorStore3d((s) => s.addMemberBetween);
  const setSupportOnNode = useEditorStore3d((s) => s.setSupportOnNode);
  const addLoadOnNode = useEditorStore3d((s) => s.addLoadOnNode);
  const deleteSelection3d = useEditorStore3d((s) => s.deleteSelection);
  const setMemberStart = useEditorStore3d((s) => s.setMemberStart);
  const setSelection3d = useEditorStore3d((s) => s.setSelection);
  const setModelName3d = useEditorStore3d((s) => s.setModelName);

  const analysis3d = useMemo(() => analyzeStaticModel3d(model3d), [model3d]);
  const eigen3d = useMemo(() => {
    if (analysis3d.kind !== 'stable') return undefined;
    try {
      return {
        modal: modal3d(analysis3d.mesh, 4),
        buckling: (() => {
          const N = new Float64Array(analysis3d.mesh.elements.length);
          for (let i = 0; i < analysis3d.mesh.elements.length; i++) {
            N[i] = -Math.abs(analysis3d.result.elementForces[i * 12]!);
          }
          return buckling3d(analysis3d.mesh, N);
        })(),
      };
    } catch {
      return undefined;
    }
  }, [analysis3d]);

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

  const activeEigen = viewDimension === '3d'
    ? (eigen3d ? (modeFamily === 'modal' ? eigen3d.modal : eigen3d.buckling) : undefined)
    : (eigen.kind === 'ready' ? (modeFamily === 'modal' ? eigen.modal : eigen.buckling) : undefined);
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
    try { return prepareTraffic(model, analysisOptions); } catch { return undefined; }
  }, [analysisOptions, mode, model]);
  const quasiStaticTraffic = useMemo(() => {
    if (!trafficScenario || model.story.kind !== 'traffic') return undefined;
    if (model.story.movingMass && storyPlaying) return undefined;
    return analyzeTrafficAt(trafficScenario, storyTime * model.story.speed);
  }, [model.story, storyPlaying, storyTime, trafficScenario]);
  const trafficFrame = movingMassFrame ?? quasiStaticTraffic;
  const capacity = useMemo(() => model.story.kind === 'ramp' ? rampCapacity(model, analysisOptions) : undefined, [analysisOptions, model]);
  const rampFactor = model.story.kind === 'ramp' && capacity !== undefined
    ? Math.min(capacity, Math.max(0.001, storyTime * capacity / 8))
    : 0.001;
  const rampFrame = useMemo(
    () => model.story.kind === 'ramp' && mode === 'test' ? analyzeRamp(model, rampFactor, storyTime >= 8, analysisOptions) : undefined,
    [analysisOptions, mode, model, rampFactor, storyTime],
  );
  const pushover = useMemo(
    () => model.story.kind === 'pushover' && mode === 'test' ? runPushover(model, analysisOptions) : undefined,
    [analysisOptions, mode, model],
  );
  const analysis = trafficFrame?.analysis ?? rampFrame?.analysis ?? baseAnalysis;
  const deformation = viewDimension === '3d'
    ? (analysis3d.kind === 'stable' ? deformationDisplay3d(analysis3d.mesh, analysis3d.result.u, 44) : null)
    : (analysis.kind === 'stable' ? deformationDisplay(analysis.mesh, analysis.result.u, 44) : null);
  const modeGhost3d = activeEigen && viewDimension === '3d' && activeEigen.values[selectedMode] !== undefined
    ? { result: activeEigen, mode: selectedMode, phase: modePhase }
    : undefined;
  const windScenario = useMemo(() => model.story.kind === 'wind' ? prepareWind(model, analysisOptions) : undefined, [analysisOptions, model]);
  const earthquakeScenario = useMemo(
    () => model.story.kind === 'earthquake' ? prepareEarthquake(model, analysisOptions) : undefined,
    [analysisOptions, model],
  );
  const modal = eigen.kind === 'ready' ? eigen.modal : undefined;
  const trafficDuration = trafficScenario && model.story.kind === 'traffic'
    ? (trafficScenario.length + 4) / Math.max(0.1, model.story.speed)
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
    setInfluenceEnvelope(false);
    setWindFrame(undefined);
    setEarthquakeFrame(undefined);
    setMovingMassFrame(undefined);
  }, [model]);

  useEffect(() => {
    if (!envelopeEnabled) {
      setInfluenceEnvelope(false);
      setMomentEnvelope(new Map());
      return;
    }
    if (!influenceEnvelope) return;
    if (model.story.kind !== 'traffic' || model.deck.length === 0) {
      setMomentEnvelope(new Map());
      return;
    }
    try {
      setMomentEnvelope(memberMomentEnvelopeFromInfluence(model, analysisOptions));
    } catch {
      setMomentEnvelope(new Map());
    }
  }, [analysisOptions, envelopeEnabled, influenceEnvelope, model]);

  useEffect(() => {
    if (!failureKey) {      setFailurePhase(undefined);
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
    if (mode !== 'test' || !storyPlaying || model.story.kind === 'wind' || model.story.kind === 'earthquake') return;
    if (model.story.kind === 'traffic' && model.story.movingMass) return;
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
  }, [capacity, mode, model.story, storyPlaying, trafficDuration]);

  useEffect(() => {
    if (mode !== 'test' || !storyPlaying || model.story.kind !== 'traffic' || !model.story.movingMass || !trafficScenario) {
      return;
    }
    const speed = Math.max(0.1, model.story.speed);
    let current = initialMovingMassState(trafficScenario, storyTime * speed);
    const duration = (trafficScenario.length + 4) / speed;
    let frame = 0;
    const tick = () => {
      const stepped = stepMovingMassTraffic(trafficScenario, current);
      current = stepped.state;
      setMovingMassFrame(stepped.frame);
      setStoryTime(current.t);
      if (current.t >= duration) {
        setStoryPlaying(false);
        setMovingMassFrame(undefined);
        setMomentEnvelope(new Map());
        setStoryTime(0);
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      setMovingMassFrame(undefined);
    };
  }, [mode, model.story, storyPlaying, trafficScenario]);

  useEffect(() => {
    if (model.story.kind !== 'traffic' || !model.story.movingMass) setMovingMassFrame(undefined);
  }, [model.story]);

  useEffect(() => {
    if (!envelopeEnabled || influenceEnvelope || !trafficFrame) return;
    setMomentEnvelope((previous) => mergeMomentEnvelope(previous, trafficFrame.analysis));
  }, [envelopeEnabled, influenceEnvelope, trafficFrame]);

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
    if (mode !== 'test' || !storyPlaying || !earthquakeScenario || !modal) return;
    const initial = initialEarthquakeState(earthquakeScenario, modal);
    if (!initial) return;
    let current = initial;
    let frame = 0;
    const tick = () => {
      current = stepEarthquake(earthquakeScenario, current);
      const yieldMember = governingYieldMember(earthquakeUtilization(earthquakeScenario, current.u));
      setEarthquakeFrame({ scenario: earthquakeScenario, t: current.t, u: current.u, yieldMember });
      setStoryTime(current.t);
      if (current.t >= earthquakeScenario.duration) {
        setStoryPlaying(false);
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    setEarthquakeFrame({ scenario: earthquakeScenario, t: initial.t, u: initial.u });
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [earthquakeScenario, modal, mode, storyPlaying]);

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

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#m=') || hash.startsWith('#mu=')) return;
    const params = new URLSearchParams(window.location.search);
    const challengeId = params.get('challenge');
    if (!challengeId) return;
    const challenge = CHALLENGES.find((candidate) => candidate.id === challengeId);
    if (!challenge) return;
    loadModel(challenge.starter, { challengeId: challenge.id });
    setNotice(challenge.brief);
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
    const timer = window.setTimeout(() => setStability(inspectStability(model, analysisOptions)), 300);
    return () => window.clearTimeout(timer);
  }, [analysisOptions, model, setStability]);

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
        <input className="model-name" aria-label="Model name" value={viewDimension === '3d' ? model3d.name : model.name} onChange={(event) => viewDimension === '3d' ? setModelName3d(event.target.value) : setModelName(event.target.value)} />
        <div className="topbar-actions">
          <div className="mode-switch" aria-label="Mode">
            <button type="button" className={mode === 'build' ? 'active' : ''} onClick={() => setMode('build')}>Build</button>
            <button type="button" className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}>Test</button>
          </div>
          <div className="view-dimension" aria-label="Dimension">
            <button type="button" className={viewDimension === '2d' ? 'active' : ''} onClick={() => setViewDimension('2d')}>2D</button>
            <button type="button" className={viewDimension === '3d' ? 'active' : ''} onClick={() => { setViewDimension('3d'); setMode('build'); }}>3D</button>
          </div>
          {viewDimension === '3d' ? (
            <select className="preset-menu" aria-label="3D demos" defaultValue="" onChange={(event) => {
              const demo = DEMOS_3D.find((d) => d.id === event.target.value);
              if (demo) loadModel3d(demo.build());
              event.currentTarget.value = '';
            }}>
              <option value="" disabled>3D demos</option>
              {DEMOS_3D.map((demo) => <option key={demo.id} value={demo.id}>{demo.label}</option>)}
            </select>
          ) : (
          <select className="preset-menu" aria-label="Presets" defaultValue="" onChange={(event) => {
            const preset = PRESETS.find((candidate) => candidate.id === event.target.value);
            if (preset) loadModel(preset.model);
            event.currentTarget.value = '';
          }}>
            <option value="" disabled>Presets</option>
            {PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          )}
          <select className="preset-menu" aria-label="Challenges" defaultValue="" onChange={(event) => {
            const challenge = CHALLENGES.find((candidate) => candidate.id === event.target.value);
            if (challenge) {
              loadModel(challenge.starter, { challengeId: challenge.id });
              setNotice(challenge.brief);
            }
            event.currentTarget.value = '';
          }}>
            <option value="" disabled>Challenges</option>
            {CHALLENGES.map((challenge) => <option key={challenge.id} value={challenge.id}>{challenge.label}</option>)}
          </select>
          <Link className="quiet-button" href="/gallery">Gallery</Link>
          <button type="button" className="quiet-button" onClick={() => void shareModel()}>Share</button>
          <button type="button" className="quiet-button" onClick={() => viewDimension === '3d' ? reset3d() : reset()}>Blank grid</button>
        </div>
      </header>
      <section className="editor-workspace">
        <nav className="tool-rail" aria-label="Build tools">
          {viewDimension === '3d' ? (
            <>
              <span className="rail-label">3D tools</span>
              {TOOLS_3D.map((candidate) => (
                <button key={candidate.id} type="button" className={tool3d === candidate.id ? 'tool active' : 'tool'} onClick={() => setTool3d(candidate.id)}>
                  <span>{candidate.label}</span><kbd>{candidate.key}</kbd>
                </button>
              ))}
              <div className="rail-bottom">
                <label className="snap-toggle">Workplane
                  <select value={workplane} onChange={(e) => setWorkplane(e.target.value as typeof workplane)} aria-label="Workplane">
                    <option value="ground">Ground XY</option>
                    <option value="xz">Elevation XZ</option>
                    <option value="yz">Elevation YZ</option>
                  </select>
                </label>
                <p className="rail-hint">Click the plane to place. Orbit with drag; member tool: node → node.</p>
              </div>
            </>
          ) : (
            <>
          <span className="rail-label">Tools</span>
          {TOOLS.map((candidate) => <button key={candidate.id} type="button" className={tool === candidate.id ? 'tool active' : 'tool'} title={`${candidate.description} (${candidate.key})`} onClick={() => setTool(candidate.id)}><span>{candidate.label}</span><kbd>{candidate.key}</kbd></button>)}
          <div className="rail-bottom">
            <label className="snap-toggle"><input type="checkbox" checked={gridSnap} onChange={(event) => setGridSnap(event.target.checked)} /> Snap 0.5 m</label>
            <button type="button" className="history-button" onClick={undo}>Undo <kbd>⌘Z</kbd></button>
            <button type="button" className="history-button" onClick={redo}>Redo <kbd>⇧⌘Z</kbd></button>
          </div>
            </>
          )}
        </nav>
        <section className="canvas-panel" aria-label="Structure workspace">
          {viewDimension === '3d' ? (
            <StructureCanvas3d
              model={model3d}
              analysis={analysis3d}
              showDeformed={showDeformed}
              modeGhost={modeGhost3d}
              workplane={workplane}
              selectedNodeId={selection3d.kind === 'node' ? selection3d.id : null}
              selectedMemberId={selection3d.kind === 'member' ? selection3d.id : null}
              onWorkplaneClick={(point, hitNodeId) => {
                if (tool3d === 'node') {
                  addNodeAt(point.x, point.y, point.z);
                  return;
                }
                if (tool3d === 'member') {
                  if (hitNodeId !== null) {
                    if (memberStart === null) setMemberStart(hitNodeId);
                    else addMemberBetween(memberStart, hitNodeId);
                  } else {
                    const id = addNodeAt(point.x, point.y, point.z);
                    if (memberStart === null) setMemberStart(id);
                    else addMemberBetween(memberStart, id);
                  }
                  return;
                }
                if (tool3d === 'support' && hitNodeId !== null) {
                  setSupportOnNode(hitNodeId);
                  return;
                }
                if (tool3d === 'load' && hitNodeId !== null) {
                  addLoadOnNode(hitNodeId);
                  return;
                }
                if (tool3d === 'delete') {
                  if (hitNodeId !== null) setSelection3d({ kind: 'node', id: hitNodeId });
                  deleteSelection3d();
                  return;
                }
                if (hitNodeId !== null) setSelection3d({ kind: 'node', id: hitNodeId });
              }}
            />
          ) : (
          <StructureCanvas
            analysis={analysis}
            diagram={resultDiagram}
            showDeformed={showDeformed}
            modeGhost={modeGhost}
            trafficAxles={trafficFrame?.axles}
            momentEnvelope={envelopeEnabled ? momentEnvelope : undefined}
            dynamicDisplacement={windFrame?.u ?? earthquakeFrame?.u}
            failureCinematic={failurePhase !== undefined && rampFrame?.analysis.kind === 'stable'
              ? { u: rampFrame.analysis.result.u, phase: failurePhase, reducedMotion }
              : undefined}
          />
          )}
          {viewDimension === '3d' && (
            <div className="demo3d-note" role="note">
              3D workplane editor — draw on Ground/XZ/YZ; orbit to inspect. Stress colors + deformed + mode ghosts from the space-frame solver. Extrude/replicate still ahead.
            </div>
          )}
          {viewDimension === '3d' && notice3d && <div className="canvas-notice" role="status">{notice3d}</div>}
          {viewDimension === '2d' && <div className={`lint-badge lint-${stability.kind}`}>{stability.message}</div>}
          {notice && viewDimension === '2d' && <div className="canvas-notice" role="status">{notice}</div>}
          {viewDimension === '2d' && activeChallengeId && (
            <ChallengePanel
              challengeId={activeChallengeId}
              model={model}
              analysisOptions={analysisOptions}
              onClear={() => setActiveChallenge(null)}
            />
          )}
          {(viewDimension === '2d' ? analysis.kind === 'stable' : analysis3d.kind === 'stable') && <div className="result-controls" aria-label="Static result display">
            {viewDimension === '2d' && (['none', 'axial', 'shear', 'moment'] as const).map((diagram) => <button key={diagram} type="button" className={resultDiagram === diagram ? 'active' : ''} onClick={() => setResultDiagram(diagram)}>{diagram === 'none' ? 'Results' : diagram[0]!.toUpperCase() + diagram.slice(1)}</button>)}
            <label><input type="checkbox" checked={showDeformed} onChange={(event) => setShowDeformed(event.target.checked)} /> Deformed</label>
            {viewDimension === '2d' && <>
            <label><input type="checkbox" checked={shearFlexible} onChange={(event) => setShearFlexible(event.target.checked)} /> Timoshenko</label>
            <label><input type="checkbox" checked={secondOrder} onChange={(event) => setSecondOrder(event.target.checked)} /> P-Δ</label>
            </>}
          </div>}
          {viewDimension === '2d' && analysis.kind === 'divergent' && <div className="shear-note" role="alert">{analysis.message}</div>}
          {viewDimension === '2d' && stockyMembers.length > 0 && <div className="shear-note" role="note">Shear flexibility matters when L/h &lt; 10 — {stockyMembers.length === 1 ? `member ${stockyMembers[0]} is` : `${stockyMembers.length} members are`} stocky{shearFlexible ? '' : '; enable Timoshenko to include it'}.</div>}
          {viewDimension === '2d' && analysis.kind === 'stable' && analysis.secondOrder && <div className="pdelta-badge" role="status">P-Δ ×{analysis.secondOrder.momentAmplification.toFixed(2)} moment · ×{analysis.secondOrder.displacementAmplification.toFixed(2)} disp vs linear ({analysis.secondOrder.iterations} iter)</div>}
          {deformation && showDeformed && deformation.maxMeters > 0 && <div className="deformation-badge">deformation ×{formatScale(deformation.scale)} — true max {formatLength(deformation.maxMeters)}</div>}
          {viewDimension === '2d' && windFrame && <div className="dynamic-badge">Newmark response — display scale ×{formatScale(deformationDisplay(windFrame.scenario.mesh, windFrame.u, 44).scale)} · simplified uniform wind field (member-normal 2D pressure)</div>}
          {viewDimension === '2d' && earthquakeFrame && <div className="dynamic-badge">Newmark response — display scale ×{formatScale(deformationDisplay(earthquakeFrame.scenario.mesh, earthquakeFrame.u, 44).scale)} · horizontal base excitation −M·ι·ü_g</div>}
          {viewDimension === '2d' && movingMassFrame?.movingMass && <div className="dynamic-badge">Moving-mass Newmark — amp ×{movingMassFrame.movingMass.amplification.toFixed(2)} vs static at this station · vehicle mass lumped at axle contacts</div>}
          {viewDimension === '2d' && failurePhase !== undefined && <div className="failure-cinematic-badge">failure animation ×{reducedMotion ? 'static' : formatScale(0.25 + failurePhase * 0.75)} — illustrative, computed onset and mechanism</div>}
          {viewDimension === '2d' && model.members.length >= MEMBER_SOFT_LIMIT && <div className="member-limit-badge">{model.members.length}/{MEMBER_HARD_LIMIT} members — performance warning at {MEMBER_SOFT_LIMIT}; hard cap {MEMBER_HARD_LIMIT}</div>}
          {(viewDimension === '3d' ? analysis3d.kind === 'stable' : analysis.kind === 'stable') && <div className="eigen-panel" aria-live="polite">
            <span>Modal + Buckling{viewDimension === '3d' ? ' (3D)' : ''}</span>
            {viewDimension === '2d' && eigen.kind === 'loading' && <p>Solving in worker…</p>}
            {viewDimension === '2d' && eigen.kind === 'error' && <p className="eigen-error">{eigen.message}</p>}
            {((viewDimension === '2d' && eigen.kind === 'ready') || (viewDimension === '3d' && eigen3d)) && activeEigen && <>
              <div className="mode-family" aria-label="Mode shape family">
                <button type="button" className={modeFamily === 'modal' ? 'active' : ''} onClick={() => { setModeFamily('modal'); setSelectedMode(0); }}>Modal</button>
                <button type="button" className={modeFamily === 'buckling' ? 'active' : ''} onClick={() => { setModeFamily('buckling'); setSelectedMode(0); }}>Buckling</button>
              </div>
              <div className="mode-list" aria-label="Animated mode shapes">
                {Array.from(activeEigen.values, (value, index) => <button key={index} type="button" className={selectedMode === index ? 'active' : ''} onClick={() => setSelectedMode(index)}>{modeFamily === 'modal' ? `f${index + 1} ${(value / (Math.PI * 2)).toFixed(2)} Hz` : `λ${index + 1} ${value.toFixed(2)}`}</button>)}
              </div>
              <p>{modeFamily === 'modal'
                ? `mode shape normalized — ${reducedMotion ? 'static (reduced motion)' : `animating at ${(animationHz ?? 0).toFixed(2)} Hz${nativeAnimationHz && nativeAnimationHz > 2 ? ' (display slowed ×4)' : ''}`}`
                : `buckling mode normalized — ${reducedMotion ? 'static (reduced motion)' : 'illustrative animation, not displacement'}`}</p>
              <p>{(viewDimension === '3d' ? eigen3d?.buckling.values[0] : eigen.kind === 'ready' ? eigen.buckling.values[0] : undefined)
                ? `λcr ${(viewDimension === '3d' ? eigen3d!.buckling.values[0]! : (eigen as { kind: 'ready'; buckling: EigenResult }).buckling.values[0]!).toFixed(2)} × reference load`
                : 'No buckling under this load direction.'}</p>
            </>}
          </div>}
          {viewDimension === '2d' && mode === 'test' && <TestConsole
            model={model}
            modal={modal}
            buckling={eigen.kind === 'ready' ? eigen.buckling : undefined}
            analysisOptions={analysisOptions}
            playing={storyPlaying}
            storyTime={storyTime}
            traffic={trafficFrame}
            trafficYieldCapacity={trafficYieldCapacity}
            envelopeEnabled={envelopeEnabled}
            onEnvelopeEnabled={(enabled) => {
              setEnvelopeEnabled(enabled);
              if (!enabled) {
                setInfluenceEnvelope(false);
                setMomentEnvelope(new Map());
              }
            }}
            influenceEnvelope={influenceEnvelope}
            onInfluenceEnvelope={(enabled) => {
              setInfluenceEnvelope(enabled);
              if (!enabled) setMomentEnvelope(new Map());
            }}
            ramp={rampFrame}
            rampCapacity={capacity}
            pushover={pushover}
            wind={windFrame}
            earthquake={earthquakeFrame}
            onTogglePlayback={() => setStoryPlaying((playing) => !playing)}
            onRestart={() => {
              setStoryTime(0);
              setWindFrame(undefined);
              setEarthquakeFrame(undefined);
              setMovingMassFrame(undefined);
              setStoryPlaying(false);
              if (influenceEnvelope && model.story.kind === 'traffic' && model.deck.length > 0) {
                try { setMomentEnvelope(memberMomentEnvelopeFromInfluence(model, analysisOptions)); }
                catch { setMomentEnvelope(new Map()); }
              } else {
                setMomentEnvelope(new Map());
              }
            }}
            onSeekTrafficStation={(station) => {
              if (model.story.kind !== 'traffic') return;
              setStoryPlaying(false);
              setMovingMassFrame(undefined);
              setStoryTime(station / Math.max(0.1, model.story.speed));
            }}
            onReplayFailure={() => { setStoryPlaying(false); setStoryTime(8); setFailureReplay((value) => value + 1); }}
            onReturn={() => setMode('build')}
          />}
        </section>
        {viewDimension === '2d' && <Inspector />}
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

interface EarthquakeFrame {
  scenario: EarthquakeScenario;
  t: number;
  u: Float64Array;
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

/** Members with L/h < 10, where shear flexibility starts to matter. */
function stockyMemberIds(model: EditorModel): number[] {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const stocky: number[] = [];
  for (const member of model.members) {
    const a = nodeById.get(member.a);
    const b = nodeById.get(member.b);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const depth = sectionDepth(member.section);
    if (depth > 0 && length / depth < 10) stocky.push(member.id);
  }
  return stocky;
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
