'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CHALLENGES } from '../challenges/catalog';
import { StructureCanvas } from '../canvas/structure-canvas';
import { StructureCanvas3d } from '../canvas/structure-canvas-3d';
import { sectionDepth } from '../fem/materials';
import { analyzeStaticModel, deformationDisplay } from '../fem/statics';
import { analyzeStaticModel3d, deformationDisplay3d, solveSecondOrderStatic3d } from '../fem/space';
import type { EditorModel, EigenResult } from '../fem/types';
import { PRESETS } from '../presets/scenes';
import { PRESETS_3D } from '../presets/scenes3d';
import {
  MEMBER_HARD_LIMIT_3D,
  MEMBER_SOFT_LIMIT_3D,
  useEditorStore3d,
  type EditorTool3d,
} from '../state/editor-store-3d';
import {
  decodeModel,
  decodeModel3d,
  encodeModel,
  encodeModel3d,
  peekShareSchemaVersion,
} from '../share/serialize';
import { inspectStability } from '../state/stability';
import {
  MEMBER_HARD_LIMIT,
  MEMBER_SOFT_LIMIT,
  type EditorTool,
  useEditorStore,
} from '../state/editor-store';
import { analyzeRamp, rampCapacity } from '../stories/ramp';
import { analyzeRamp3d, rampCapacity3d } from '../stories/ramp3d';
import {
  analyzeTrafficAt,
  initialMovingMassState,
  mergeMomentEnvelope,
  prepareTraffic,
  stepMovingMassTraffic,
  trafficYieldWeightAt,
  type TrafficFrame,
} from '../stories/traffic';
import { memberMomentEnvelopeFromInfluence } from '../fem/influence';
import { runPushover } from '../fem/pushover';
import { runPushover3d } from '../fem/space/pushover';
import {
  earthquakeUtilization,
  initialEarthquakeState,
  prepareEarthquake,
  stepEarthquake,
  type EarthquakeScenario,
} from '../stories/earthquake';
import {
  earthquakeUtilization3d,
  initialEarthquakeState3d,
  prepareEarthquake3d,
  stepEarthquake3d,
  type EarthquakeScenario3d,
} from '../stories/earthquake3d';
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
import {
  detectResonance3d,
  initialWindState3d,
  measuredDaf3d,
  modalCoordinates3d,
  prepareWind3d,
  stepWind3d,
  windReferenceCoordinates3d,
  type WindScenario3d,
} from '../stories/wind3d';
import {
  analyzeTrafficAt3d,
  initialMovingMassState3d,
  prepareTraffic3d,
  stepMovingMassTraffic3d,
  type TrafficFrame3d,
} from '../stories/traffic3d';
import { ChallengePanel } from './challenge-panel';
import { Inspector } from './inspector';
import { Inspector3d } from './inspector-3d';
import { TestConsole } from './test-console';
import { TestConsole3d } from './test-console-3d';
import Link from 'next/link';
import type { EditorModel3d, StaticAnalysis3d, StorySpec3d } from '../fem/space';
import type { NewmarkState } from '../fem/dynamics';

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
  { id: 'deck', label: 'Deck', key: 'D' },
  { id: 'workplane', label: 'Plane', key: 'P' },
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
  const analysisOptions = useMemo(
    () => ({ shearFlexible, secondOrder }),
    [secondOrder, shearFlexible],
  );
  const baseAnalysis = useMemo(
    () => analyzeStaticModel(model, analysisOptions),
    [analysisOptions, model],
  );
  const stockyMembers = useMemo(() => stockyMemberIds(model), [model]);
  const requestId = useRef(0);
  const [eigen, setEigen] = useState<EigenUiState>({ kind: 'idle' });
  const requestId3d = useRef(0);
  const [eigen3dState, setEigen3dState] = useState<EigenUiState>({ kind: 'idle' });
  const [selectedMode, setSelectedMode] = useState(0);
  const [modeFamily, setModeFamily] = useState<'modal' | 'buckling'>('modal');
  const [modePhase, setModePhase] = useState(1);
  const [storyPlaying, setStoryPlaying] = useState(false);
  const [storyTime, setStoryTime] = useState(0);
  const [momentEnvelope, setMomentEnvelope] = useState<Map<number, number>>(new Map());
  const [envelopeEnabled, setEnvelopeEnabled] = useState(false);
  const [influenceEnvelope, setInfluenceEnvelope] = useState(false);
  const [windFrame, setWindFrame] = useState<WindFrame>();
  const [windFrame3d, setWindFrame3d] = useState<WindFrame3d>();
  const [trafficFrame3d, setTrafficFrame3d] = useState<TrafficFrame3d>();
  const [movingMassFrame3d, setMovingMassFrame3d] = useState<TrafficFrame3d>();
  const [earthquakeFrame, setEarthquakeFrame] = useState<EarthquakeFrame>();
  const [earthquakeFrame3d, setEarthquakeFrame3d] = useState<EarthquakeFrame3d>();
  const [movingMassFrame, setMovingMassFrame] = useState<TrafficFrame>();
  const [failureReplay, setFailureReplay] = useState(0);
  const [failurePhase, setFailurePhase] = useState<number>();
  const [failureReplay3d, setFailureReplay3d] = useState(0);
  const [failurePhase3d, setFailurePhase3d] = useState<number>();
  const [viewDimension, setViewDimension] = useState<'2d' | '3d'>('2d');
  const [storyPlaying3d, setStoryPlaying3d] = useState(false);
  const [storyTime3d, setStoryTime3d] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  const model3d = useEditorStore3d((s) => s.model);
  const tool3d = useEditorStore3d((s) => s.tool);
  const workplane = useEditorStore3d((s) => s.workplane);
  const selection3d = useEditorStore3d((s) => s.selection);
  const memberStart = useEditorStore3d((s) => s.memberStart);
  const notice3d = useEditorStore3d((s) => s.notice);
  const extrudeDistance = useEditorStore3d((s) => s.extrudeDistance);
  const extrudeCount = useEditorStore3d((s) => s.extrudeCount);
  const setTool3d = useEditorStore3d((s) => s.setTool);
  const setWorkplanePreset = useEditorStore3d((s) => s.setWorkplanePreset);
  const beginCustomWorkplane = useEditorStore3d((s) => s.beginCustomWorkplane);
  const pickCustomWorkplanePoint = useEditorStore3d((s) => s.pickCustomWorkplanePoint);
  const setExtrudeDistance = useEditorStore3d((s) => s.setExtrudeDistance);
  const setExtrudeCount = useEditorStore3d((s) => s.setExtrudeCount);
  const extrude3d = useEditorStore3d((s) => s.extrude);
  const replicate3d = useEditorStore3d((s) => s.replicate);
  const setWindStory = useEditorStore3d((s) => s.setWindStory);
  const setTrafficStory = useEditorStore3d((s) => s.setTrafficStory);
  const setRampStory = useEditorStore3d((s) => s.setRampStory);
  const setPushoverStory = useEditorStore3d((s) => s.setPushoverStory);
  const setEarthquakeStory = useEditorStore3d((s) => s.setEarthquakeStory);
  const toggleDeckMember = useEditorStore3d((s) => s.toggleDeckMember);
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
  const setNotice3d = useEditorStore3d((s) => s.setNotice);
  const undo3d = useEditorStore3d((s) => s.undo);
  const redo3d = useEditorStore3d((s) => s.redo);
  const past3d = useEditorStore3d((s) => s.past);
  const future3d = useEditorStore3d((s) => s.future);
  const resultDiagram3d = useEditorStore3d((s) => s.resultDiagram);
  const setResultDiagram3d = useEditorStore3d((s) => s.setResultDiagram);
  const shearFlexible3d = useEditorStore3d((s) => s.shearFlexible);
  const secondOrder3d = useEditorStore3d((s) => s.secondOrder);
  const setShearFlexible3d = useEditorStore3d((s) => s.setShearFlexible);
  const setSecondOrder3d = useEditorStore3d((s) => s.setSecondOrder);

  const analysis3d = useMemo(
    () =>
      secondOrder3d
        ? solveSecondOrderStatic3d(model3d, { shearFlexible: shearFlexible3d })
        : analyzeStaticModel3d(model3d, { shearFlexible: shearFlexible3d }),
    [model3d, secondOrder3d, shearFlexible3d],
  );
  const stockyMembers3d = useMemo(() => stockyMemberIds3d(model3d), [model3d]);
  const canvasAnalysis3d: StaticAnalysis3d =
    analysis3d.kind === 'stable' ||
    analysis3d.kind === 'invalid' ||
    (analysis3d.kind === 'mechanism' && 'freeDofIndex' in analysis3d)
      ? (analysis3d as StaticAnalysis3d)
      : { kind: 'invalid', message: analysis3d.message };
  const eigen3d = eigen3dState.kind === 'ready' ? eigen3dState : undefined;
  useEffect(() => {
    if (analysis3d.kind !== 'stable') {
      setEigen3dState({ kind: 'idle' });
      return;
    }
    const id = ++requestId3d.current;
    const worker = new Worker(new URL('../workers/eigen.worker.ts', import.meta.url));
    setEigen3dState({ kind: 'loading' });
    worker.onmessage = (event: MessageEvent<EigenWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.ok) {
        setEigen3dState({ kind: 'ready', modal: response.modal, buckling: response.buckling });
        setSelectedMode(0);
      } else setEigen3dState({ kind: 'error', message: response.message });
    };
    worker.onerror = () =>
      setEigen3dState({ kind: 'error', message: '3D eigen worker could not start.' });
    const source = analysis3d.mesh;
    const mesh = {
      ...source,
      coords: source.coords.slice(),
      editorNode: source.editorNode.slice(),
      freeDofs: source.freeDofs.slice(),
      elements: source.elements.map((element) => ({ ...element, R: element.R.slice() })),
    };
    const elementN = new Float64Array(mesh.elements.length);
    // Tension-positive N = −Fx at end A, signed: a member in tension stiffens
    // the structure against buckling, so forcing every member into compression
    // would report a load factor for a state the model is not in.
    // docs/FEM-SPEC.md §4.5 / §4.9.
    for (let index = 0; index < elementN.length; index++)
      elementN[index] = -analysis3d.result.elementForces[index * 12]!;
    const requestedModes = mesh.ndof > 1500 ? 4 : 8;
    const nModes = Math.min(requestedModes, Math.max(1, mesh.freeDofs.length - 1));
    worker.postMessage({ id, dimension: '3d', mesh, elementN, nModes }, [
      mesh.coords.buffer,
      mesh.editorNode.buffer,
      mesh.freeDofs.buffer,
      elementN.buffer,
      ...mesh.elements.map((element) => element.R.buffer),
    ]);
    return () => worker.terminate();
  }, [analysis3d]);
  const windScenario3d = useMemo(
    () =>
      viewDimension === '3d' && model3d.story?.kind === 'wind' ? prepareWind3d(model3d) : undefined,
    [model3d, viewDimension],
  );
  const trafficScenario3d = useMemo(() => {
    if (viewDimension !== '3d' || model3d.story?.kind !== 'traffic' || !model3d.deck?.length)
      return undefined;
    try {
      return prepareTraffic3d(model3d);
    } catch {
      return undefined;
    }
  }, [model3d, viewDimension]);
  const earthquakeScenario3d = useMemo(
    () =>
      viewDimension === '3d' && model3d.story?.kind === 'earthquake'
        ? prepareEarthquake3d(model3d)
        : undefined,
    [model3d, viewDimension],
  );
  const capacity3d = useMemo(
    () => (model3d.story?.kind === 'ramp' ? rampCapacity3d(model3d) : undefined),
    [model3d],
  );
  const rampFactor3d =
    model3d.story?.kind === 'ramp' && capacity3d !== undefined
      ? Math.min(capacity3d, Math.max(0.001, (storyTime3d * capacity3d) / 8))
      : 0.001;
  const rampFrame3d = useMemo(
    () =>
      model3d.story?.kind === 'ramp' && viewDimension === '3d'
        ? analyzeRamp3d(model3d, rampFactor3d, storyTime3d >= 8)
        : undefined,
    [model3d, rampFactor3d, storyTime3d, viewDimension],
  );
  const pushover3d = useMemo(
    () =>
      model3d.story?.kind === 'pushover' && viewDimension === '3d'
        ? runPushover3d(model3d)
        : undefined,
    [model3d, viewDimension],
  );
  const trafficFrame3dActive = movingMassFrame3d ?? trafficFrame3d;

  useEffect(() => {
    if (viewDimension !== '3d' || !storyPlaying3d || !windScenario3d || !eigen3d) return;
    const initial = initialWindState3d(windScenario3d, eigen3d.modal);
    if (!initial) return;
    const initialCoordinates = modalCoordinates3d(
      windScenario3d.mesh,
      eigen3d.modal,
      initial.u,
      windScenario3d.mass,
    );
    const referenceCoordinates = windReferenceCoordinates3d(windScenario3d, eigen3d.modal);
    let current = initial;
    let history: number[] = [];
    let frame = 0;
    const tick = () => {
      current = stepWind3d(windScenario3d, current);
      const raw = modalCoordinates3d(
        windScenario3d.mesh,
        eigen3d.modal,
        current.u,
        windScenario3d.mass,
      );
      const coordinates = new Float64Array(raw.length);
      for (let index = 0; index < coordinates.length; index++)
        coordinates[index] = raw[index]! - initialCoordinates[index]!;
      const nearestMode = nearestFrequencyMode(eigen3d.modal, windScenario3d.model.freqHz);
      const samplesPerCycle = Math.max(
        1,
        Math.ceil(1 / (windScenario3d.dt * 4 * Math.max(0.05, windScenario3d.model.freqHz))),
      );
      history = [...history, Math.abs(coordinates[nearestMode] ?? 0)].slice(-samplesPerCycle * 5);
      const resonanceMode = detectResonance3d(
        windScenario3d.model.freqHz,
        eigen3d.modal,
        windScenario3d.model.zeta,
        history,
        samplesPerCycle,
      );
      const daf = measuredDaf3d(coordinates, referenceCoordinates);
      setWindFrame3d({
        scenario: windScenario3d,
        t: current.t,
        u: current.u,
        coordinates,
        daf,
        resonanceMode,
      });
      setStoryTime3d(current.t);
      frame = window.requestAnimationFrame(tick);
    };
    setWindFrame3d({
      scenario: windScenario3d,
      t: initial.t,
      u: initial.u,
      coordinates: new Float64Array(initialCoordinates.length),
      daf: measuredDaf3d(new Float64Array(initialCoordinates.length), referenceCoordinates),
    });
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [eigen3d, storyPlaying3d, viewDimension, windScenario3d]);

  useEffect(() => {
    if (viewDimension !== '3d' || !trafficScenario3d || model3d.story?.kind !== 'traffic') {
      setTrafficFrame3d(undefined);
      return;
    }
    if (storyPlaying3d) return;
    setTrafficFrame3d(analyzeTrafficAt3d(trafficScenario3d, storyTime3d * model3d.story.speed));
  }, [model3d.story, storyPlaying3d, storyTime3d, trafficScenario3d, viewDimension]);

  useEffect(() => {
    if (
      viewDimension !== '3d' ||
      !storyPlaying3d ||
      !trafficScenario3d ||
      model3d.story?.kind !== 'traffic' ||
      model3d.story.movingMass
    )
      return;
    const speed = Math.max(0.1, model3d.story.speed);
    const duration = (trafficScenario3d.length + 4) / speed;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      setStoryTime3d((current) => {
        const next = current + dt;
        if (next >= duration) {
          setStoryPlaying3d(false);
          return 0;
        }
        setTrafficFrame3d(analyzeTrafficAt3d(trafficScenario3d, next * speed));
        return next;
      });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [model3d.story, storyPlaying3d, trafficScenario3d, viewDimension]);

  useEffect(() => {
    if (
      viewDimension !== '3d' ||
      !storyPlaying3d ||
      !trafficScenario3d ||
      model3d.story?.kind !== 'traffic' ||
      !model3d.story.movingMass
    ) {
      if (!(model3d.story?.kind === 'traffic' && model3d.story.movingMass && storyPlaying3d)) {
        setMovingMassFrame3d(undefined);
      }
      return;
    }
    const speed = Math.max(0.1, model3d.story.speed);
    const duration = (trafficScenario3d.length + 4) / speed;
    let current: NewmarkState = initialMovingMassState3d(trafficScenario3d, 0);
    let frame = 0;
    const tick = () => {
      const stepped = stepMovingMassTraffic3d(trafficScenario3d, current);
      current = stepped.state;
      setMovingMassFrame3d(stepped.frame);
      setStoryTime3d(current.t);
      if (current.t >= duration) {
        setStoryPlaying3d(false);
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [model3d.story, storyPlaying3d, trafficScenario3d, viewDimension]);

  useEffect(() => {
    if (viewDimension !== '3d' || !storyPlaying3d || !earthquakeScenario3d || !eigen3d) return;
    const initial = initialEarthquakeState3d(earthquakeScenario3d, eigen3d.modal);
    if (!initial) return;
    let current = initial;
    let frame = 0;
    const tick = () => {
      current = stepEarthquake3d(earthquakeScenario3d, current);
      const yieldMember = governingYieldMember(
        earthquakeUtilization3d(earthquakeScenario3d, current.u),
      );
      setEarthquakeFrame3d({
        scenario: earthquakeScenario3d,
        t: current.t,
        u: current.u,
        yieldMember,
      });
      setStoryTime3d(current.t);
      if (current.t >= earthquakeScenario3d.duration) {
        setStoryPlaying3d(false);
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    setEarthquakeFrame3d({ scenario: earthquakeScenario3d, t: initial.t, u: initial.u });
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [earthquakeScenario3d, eigen3d, storyPlaying3d, viewDimension]);

  useEffect(() => {
    if (viewDimension !== '3d' || !storyPlaying3d || model3d.story?.kind !== 'ramp') return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      setStoryTime3d((current) => {
        const next = current + dt;
        if (capacity3d !== undefined && next >= 8) {
          setStoryPlaying3d(false);
          return 8;
        }
        return next;
      });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [capacity3d, model3d.story, storyPlaying3d, viewDimension]);

  useEffect(() => {
    if (viewDimension !== '3d') {
      setStoryPlaying3d(false);
      setWindFrame3d(undefined);
      setTrafficFrame3d(undefined);
      setMovingMassFrame3d(undefined);
      setEarthquakeFrame3d(undefined);
      setStoryTime3d(0);
    }
  }, [viewDimension]);

  useEffect(() => {
    setStoryPlaying3d(false);
    setWindFrame3d(undefined);
    setTrafficFrame3d(undefined);
    setMovingMassFrame3d(undefined);
    setEarthquakeFrame3d(undefined);
    setStoryTime3d(0);
  }, [model3d.story, model3d.nodes, model3d.members, model3d.deck]);

  const failureReport3d =
    rampFrame3d?.report && rampFrame3d.report.kind !== 'stable' ? rampFrame3d.report : undefined;
  const failureKey3d = failureReport3d
    ? `${failureReport3d.kind}-${rampFrame3d?.factor ?? 0}`
    : undefined;
  useEffect(() => {
    if (!failureKey3d) {
      setFailurePhase3d(undefined);
      return;
    }
    if (reducedMotion) {
      setFailurePhase3d(1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 2400);
      setFailurePhase3d(t);
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [failureKey3d, failureReplay3d, reducedMotion]);

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
    for (let index = 0; index < axialForces.length; index++)
      axialForces[index] = baseAnalysis.result.elementForces[index * 5]!;
    // Transfer worker-owned copies.  The live mesh remains usable by rendering,
    // animation, and a newer request while this solve is in flight.
    const mesh = {
      ...baseAnalysis.mesh,
      coords: baseAnalysis.mesh.coords.slice(),
      editorNode: baseAnalysis.mesh.editorNode.slice(),
      freeDofs: baseAnalysis.mesh.freeDofs.slice(),
    };
    worker.postMessage({ id, dimension: '2d', mesh, elementN: axialForces, nModes: 8 }, [
      mesh.coords.buffer,
      mesh.editorNode.buffer,
      mesh.freeDofs.buffer,
      axialForces.buffer,
    ]);
    return () => worker.terminate();
  }, [baseAnalysis]);

  const activeEigen =
    viewDimension === '3d'
      ? eigen3d
        ? modeFamily === 'modal'
          ? eigen3d.modal
          : eigen3d.buckling
        : undefined
      : eigen.kind === 'ready'
        ? modeFamily === 'modal'
          ? eigen.modal
          : eigen.buckling
        : undefined;
  const activeFrequency = modeFamily === 'modal' ? activeEigen?.values[selectedMode] : undefined;
  const nativeAnimationHz = activeFrequency
    ? activeFrequency / (Math.PI * 2)
    : modeFamily === 'buckling'
      ? 0.5
      : undefined;
  const animationHz =
    nativeAnimationHz && nativeAnimationHz > 2 ? nativeAnimationHz / 4 : nativeAnimationHz;
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
  const modeGhost =
    activeEigen && activeEigen.values[selectedMode] !== undefined
      ? { vectors: activeEigen.vectors, mode: selectedMode, phase: modePhase }
      : undefined;

  const trafficScenario = useMemo(() => {
    if (model.story.kind !== 'traffic' || mode !== 'test') return undefined;
    try {
      return prepareTraffic(model, analysisOptions);
    } catch {
      return undefined;
    }
  }, [analysisOptions, mode, model]);
  const quasiStaticTraffic = useMemo(() => {
    if (!trafficScenario || model.story.kind !== 'traffic') return undefined;
    if (model.story.movingMass && storyPlaying) return undefined;
    return analyzeTrafficAt(trafficScenario, storyTime * model.story.speed);
  }, [model.story, storyPlaying, storyTime, trafficScenario]);
  const trafficFrame = movingMassFrame ?? quasiStaticTraffic;
  const capacity = useMemo(
    () => (model.story.kind === 'ramp' ? rampCapacity(model, analysisOptions) : undefined),
    [analysisOptions, model],
  );
  const rampFactor =
    model.story.kind === 'ramp' && capacity !== undefined
      ? Math.min(capacity, Math.max(0.001, (storyTime * capacity) / 8))
      : 0.001;
  const rampFrame = useMemo(
    () =>
      model.story.kind === 'ramp' && mode === 'test'
        ? analyzeRamp(model, rampFactor, storyTime >= 8, analysisOptions)
        : undefined,
    [analysisOptions, mode, model, rampFactor, storyTime],
  );
  const pushover = useMemo(
    () =>
      model.story.kind === 'pushover' && mode === 'test'
        ? runPushover(model, analysisOptions)
        : undefined,
    [analysisOptions, mode, model],
  );
  const analysis = trafficFrame?.analysis ?? rampFrame?.analysis ?? baseAnalysis;
  const deformation =
    viewDimension === '3d'
      ? analysis3d.kind === 'stable'
        ? deformationDisplay3d(analysis3d.mesh, analysis3d.result.u, 44)
        : null
      : analysis.kind === 'stable'
        ? deformationDisplay(analysis.mesh, analysis.result.u, 44)
        : null;
  const modeGhost3d =
    activeEigen && viewDimension === '3d' && activeEigen.values[selectedMode] !== undefined
      ? { result: activeEigen, mode: selectedMode, phase: modePhase }
      : undefined;
  const windScenario = useMemo(
    () => (model.story.kind === 'wind' ? prepareWind(model, analysisOptions) : undefined),
    [analysisOptions, model],
  );
  const earthquakeScenario = useMemo(
    () =>
      model.story.kind === 'earthquake' ? prepareEarthquake(model, analysisOptions) : undefined,
    [analysisOptions, model],
  );
  const modal = eigen.kind === 'ready' ? eigen.modal : undefined;
  const trafficDuration =
    trafficScenario && model.story.kind === 'traffic'
      ? (trafficScenario.length + 4) / Math.max(0.1, model.story.speed)
      : undefined;
  const trafficYieldCapacity = useMemo(
    () =>
      !storyPlaying && trafficScenario && model.story.kind === 'traffic'
        ? (trafficYieldWeightAt(trafficScenario, storyTime * model.story.speed) ?? null)
        : undefined,
    [model.story, storyPlaying, storyTime, trafficScenario],
  );
  const failureReport =
    rampFrame?.report && rampFrame.report.kind !== 'stable' ? rampFrame.report : undefined;
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
    if (
      mode !== 'test' ||
      !storyPlaying ||
      model.story.kind === 'wind' ||
      model.story.kind === 'earthquake'
    )
      return;
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
    if (
      mode !== 'test' ||
      !storyPlaying ||
      model.story.kind !== 'traffic' ||
      !model.story.movingMass ||
      !trafficScenario
    ) {
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
    const initialCoordinates = modalCoordinates(
      windScenario.mesh,
      modal,
      initial.u,
      windScenario.mass,
    );
    const referenceCoordinates = windReferenceCoordinates(windScenario, modal);
    let current = initial;
    let history: number[] = [];
    let frame = 0;
    const tick = () => {
      current = stepWind(windScenario, current);
      const rawCoordinates = modalCoordinates(
        windScenario.mesh,
        modal,
        current.u,
        windScenario.mass,
      );
      const coordinates = new Float64Array(rawCoordinates.length);
      for (let index = 0; index < coordinates.length; index++)
        coordinates[index] = rawCoordinates[index]! - initialCoordinates[index]!;
      const nearestMode = nearestFrequencyMode(modal, windScenario.model.freqHz);
      const samplesPerCycle = Math.max(
        1,
        Math.ceil(1 / (windScenario.dt * 4 * Math.max(0.05, windScenario.model.freqHz))),
      );
      history = [...history, Math.abs(coordinates[nearestMode] ?? 0)].slice(-samplesPerCycle * 5);
      const resonanceMode = detectResonance(
        windScenario.model.freqHz,
        modal,
        windScenario.model.zeta,
        history,
        samplesPerCycle,
      );
      const daf = measuredDaf(coordinates, referenceCoordinates);
      const yieldMember = governingYieldMember(windUtilization(windScenario, current.u));
      setWindFrame({
        scenario: windScenario,
        t: current.t,
        u: current.u,
        coordinates,
        daf,
        resonanceMode,
        yieldMember,
      });
      setStoryTime(current.t);
      frame = window.requestAnimationFrame(tick);
    };
    setWindFrame({
      scenario: windScenario,
      t: initial.t,
      u: initial.u,
      coordinates: new Float64Array(initialCoordinates.length),
      daf: measuredDaf(new Float64Array(initialCoordinates.length), referenceCoordinates),
    });
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
      const yieldMember = governingYieldMember(
        earthquakeUtilization(earthquakeScenario, current.u),
      );
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
    void (async () => {
      try {
        const version = await peekShareSchemaVersion(hash);
        if (cancelled) return;
        if (version === 2) {
          const shared = await decodeModel3d(hash);
          if (cancelled) return;
          loadModel3d(shared);
          setViewDimension('3d');
          setNotice3d('Loaded shared 3D model from URL.');
          return;
        }
        const shared = await decodeModel(hash);
        if (cancelled) return;
        loadModel(shared);
        setViewDimension('2d');
      } catch {
        if (!cancelled) setNotice('This share URL could not be decoded.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadModel, loadModel3d, setNotice, setNotice3d]);

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
    let hash: string;
    try {
      hash = viewDimension === '3d' ? await encodeModel3d(model3d) : await encodeModel(model);
    } catch {
      setNotice('Share link could not be encoded.');
      if (viewDimension === '3d') setNotice3d('3D share link could not be encoded.');
      return;
    }
    window.history.replaceState(null, '', hash);

    // The address bar now carries the model either way. Only the clipboard write
    // can still fail — no permission, or no Clipboard API off a secure origin —
    // and claiming "copied" when it did not is exactly the kind of unearned
    // statement this product does not make.
    let copied = false;
    try {
      await navigator.clipboard.writeText(window.location.href);
      copied = true;
    } catch {
      copied = false;
    }

    const prefix = viewDimension === '3d' ? '3D share link' : 'Share link';
    setNotice(
      copied
        ? `${prefix} copied — the model stays entirely in the URL.`
        : `${prefix} is in the address bar — copy it from there.`,
    );
    if (viewDimension === '3d') {
      setNotice3d(
        copied
          ? '3D share link copied — schema v2 in the URL hash.'
          : '3D share link is in the address bar — schema v2 in the URL hash.',
      );
    }
  };

  useEffect(() => {
    setStability({ kind: 'checking', message: 'Checking stability…' });
    const timer = window.setTimeout(
      () => setStability(inspectStability(model, analysisOptions)),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [analysisOptions, model, setStability]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (viewDimension === '3d') {
          if (event.shiftKey) redo3d();
          else undo3d();
        } else if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === ' ') {
        if (mode === 'test') {
          event.preventDefault();
          setStoryPlaying((playing) => !playing);
        }
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setTool('delete');
        return;
      }
      const matching = TOOLS.find(
        (candidate) => candidate.key.toLowerCase() === event.key.toLowerCase(),
      );
      if (matching) setTool(matching.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, redo, redo3d, setTool, undo, undo3d, viewDimension]);

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            △
          </span>
          <span>Limit State</span>
        </div>
        <input
          className="model-name"
          aria-label="Model name"
          value={viewDimension === '3d' ? model3d.name : model.name}
          onChange={(event) =>
            viewDimension === '3d'
              ? setModelName3d(event.target.value)
              : setModelName(event.target.value)
          }
        />
        <div className="topbar-actions">
          <div className="mode-switch" aria-label="Mode">
            <button
              type="button"
              className={mode === 'build' ? 'active' : ''}
              onClick={() => setMode('build')}
            >
              Build
            </button>
            <button
              type="button"
              className={mode === 'test' ? 'active' : ''}
              onClick={() => setMode('test')}
            >
              Test
            </button>
          </div>
          <div className="view-dimension" aria-label="Dimension">
            <button
              type="button"
              className={viewDimension === '2d' ? 'active' : ''}
              onClick={() => setViewDimension('2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={viewDimension === '3d' ? 'active' : ''}
              onClick={() => {
                setViewDimension('3d');
                setMode('build');
              }}
            >
              3D
            </button>
          </div>
          {viewDimension === '3d' ? (
            <select
              className="preset-menu"
              aria-label="3D presets"
              defaultValue=""
              onChange={(event) => {
                const preset = PRESETS_3D.find((d) => d.id === event.target.value);
                if (preset) loadModel3d(preset.build());
                event.currentTarget.value = '';
              }}
            >
              <option value="" disabled>
                3D presets
              </option>
              {PRESETS_3D.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          ) : (
            <select
              className="preset-menu"
              aria-label="Presets"
              defaultValue=""
              onChange={(event) => {
                const preset = PRESETS.find((candidate) => candidate.id === event.target.value);
                if (preset) loadModel(preset.model);
                event.currentTarget.value = '';
              }}
            >
              <option value="" disabled>
                Presets
              </option>
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          )}
          <select
            className="preset-menu"
            aria-label="Challenges"
            defaultValue=""
            onChange={(event) => {
              const challenge = CHALLENGES.find((candidate) => candidate.id === event.target.value);
              if (challenge) {
                loadModel(challenge.starter, { challengeId: challenge.id });
                setNotice(challenge.brief);
              }
              event.currentTarget.value = '';
            }}
          >
            <option value="" disabled>
              Challenges
            </option>
            {CHALLENGES.map((challenge) => (
              <option key={challenge.id} value={challenge.id}>
                {challenge.label}
              </option>
            ))}
          </select>
          <Link className="quiet-button" href="/gallery">
            Gallery
          </Link>
          <button type="button" className="quiet-button" onClick={() => void shareModel()}>
            Share
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => (viewDimension === '3d' ? reset3d() : reset())}
          >
            Blank grid
          </button>
        </div>
      </header>
      <section className="editor-workspace">
        <nav className="tool-rail" aria-label="Build tools">
          {viewDimension === '3d' ? (
            <>
              <span className="rail-label">3D tools</span>
              {TOOLS_3D.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={tool3d === candidate.id ? 'tool active' : 'tool'}
                  onClick={() => setTool3d(candidate.id)}
                >
                  <span>{candidate.label}</span>
                  <kbd>{candidate.key}</kbd>
                </button>
              ))}
              <div className="rail-bottom">
                <label className="snap-toggle">
                  Workplane
                  <select
                    value={workplane.kind === 'custom' ? 'custom' : workplane.kind}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === 'custom') beginCustomWorkplane();
                      else setWorkplanePreset(value as 'ground' | 'xz' | 'yz');
                    }}
                    aria-label="Workplane"
                  >
                    <option value="ground">Ground XY</option>
                    <option value="xz">Elevation XZ</option>
                    <option value="yz">Elevation YZ</option>
                    <option value="custom">Custom (3-click)…</option>
                  </select>
                </label>
                <div className="extrude-panel" aria-label="Extrude and replicate">
                  <label className="snap-toggle">
                    Distance (m)
                    <input
                      type="number"
                      min={0.1}
                      step={0.5}
                      value={extrudeDistance}
                      onChange={(e) => setExtrudeDistance(Number(e.target.value) || 0.1)}
                      aria-label="Extrude distance"
                    />
                  </label>
                  <label className="snap-toggle">
                    Copies
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={extrudeCount}
                      onChange={(e) => setExtrudeCount(Number(e.target.value) || 1)}
                      aria-label="Extrude copies"
                    />
                  </label>
                  <button
                    type="button"
                    className="history-button"
                    onClick={() => extrude3d()}
                    title="Copy along workplane normal and add connecting struts"
                  >
                    Extrude
                  </button>
                  <button
                    type="button"
                    className="history-button"
                    onClick={() => replicate3d()}
                    title="Array-copy along workplane normal without struts"
                  >
                    Replicate
                  </button>
                </div>
                <p className="rail-hint">
                  Draw on a plane, then Extrude along its normal (Ground → +Z) to go spatial.
                  Replicate arrays bays without connectors.
                </p>
              </div>
              <div className="rail-bottom">
                <button
                  type="button"
                  className="history-button"
                  onClick={undo3d}
                  disabled={past3d.length === 0}
                >
                  Undo <kbd>⌘Z</kbd>
                </button>
                <button
                  type="button"
                  className="history-button"
                  onClick={redo3d}
                  disabled={future3d.length === 0}
                >
                  Redo <kbd>⇧⌘Z</kbd>
                </button>
                <span
                  className={`rail-lint ${model3d.members.length >= MEMBER_HARD_LIMIT_3D ? 'hard' : model3d.members.length >= MEMBER_SOFT_LIMIT_3D ? 'soft' : ''}`}
                >
                  {model3d.members.length}/{MEMBER_HARD_LIMIT_3D} members
                  {analysis3d.kind === 'mechanism'
                    ? ' · mechanism'
                    : analysis3d.kind === 'invalid'
                      ? ' · invalid'
                      : ''}
                </span>
              </div>
            </>
          ) : (
            <>
              <span className="rail-label">Tools</span>
              {TOOLS.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={tool === candidate.id ? 'tool active' : 'tool'}
                  title={`${candidate.description} (${candidate.key})`}
                  onClick={() => setTool(candidate.id)}
                >
                  <span>{candidate.label}</span>
                  <kbd>{candidate.key}</kbd>
                </button>
              ))}
              <div className="rail-bottom">
                <label className="snap-toggle">
                  <input
                    type="checkbox"
                    checked={gridSnap}
                    onChange={(event) => setGridSnap(event.target.checked)}
                  />{' '}
                  Snap 0.5 m
                </label>
                <button type="button" className="history-button" onClick={undo}>
                  Undo <kbd>⌘Z</kbd>
                </button>
                <button type="button" className="history-button" onClick={redo}>
                  Redo <kbd>⇧⌘Z</kbd>
                </button>
              </div>
            </>
          )}
        </nav>
        <section className="canvas-panel" aria-label="Structure workspace">
          {viewDimension === '3d' ? (
            <StructureCanvas3d
              model={model3d}
              analysis={
                rampFrame3d?.analysis.kind === 'stable'
                  ? rampFrame3d.analysis
                  : trafficFrame3dActive?.analysis.kind === 'stable'
                    ? trafficFrame3dActive.analysis
                    : canvasAnalysis3d
              }
              showDeformed={
                showDeformed ||
                Boolean(windFrame3d) ||
                Boolean(earthquakeFrame3d) ||
                Boolean(trafficFrame3dActive?.analysis.kind === 'stable') ||
                Boolean(rampFrame3d?.analysis.kind === 'stable')
              }
              modeGhost={modeGhost3d}
              dynamicDisplacement={
                windFrame3d?.u ??
                earthquakeFrame3d?.u ??
                (failurePhase3d !== undefined && rampFrame3d?.analysis.kind === 'stable'
                  ? scaleDisplacement3d(rampFrame3d.analysis.result.u, 0.25 + failurePhase3d * 0.75)
                  : undefined) ??
                (trafficFrame3dActive?.analysis.kind === 'stable'
                  ? trafficFrame3dActive.analysis.result.u
                  : undefined) ??
                (rampFrame3d?.analysis.kind === 'stable'
                  ? rampFrame3d.analysis.result.u
                  : undefined)
              }
              trafficAxles={trafficFrame3dActive?.axles}
              workplane={workplane}
              selectedNodeId={selection3d.kind === 'node' ? selection3d.id : null}
              selectedMemberId={selection3d.kind === 'member' ? selection3d.id : null}
              selectedMemberIds={selection3d.kind === 'members' ? selection3d.ids : []}
              diagram={mode === 'test' ? resultDiagram3d : 'none'}
              onWorkplaneClick={(point, hitNodeId, hitMemberId, modifiers) => {
                if (tool3d === 'workplane') {
                  pickCustomWorkplanePoint(point);
                  return;
                }
                if (tool3d === 'deck') {
                  if (hitMemberId !== null) toggleDeckMember(hitMemberId);
                  return;
                }
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
                  else if (hitMemberId !== null)
                    setSelection3d({ kind: 'member', id: hitMemberId });
                  deleteSelection3d();
                  return;
                }
                if (hitNodeId !== null) {
                  setSelection3d({ kind: 'node', id: hitNodeId });
                } else if (hitMemberId !== null) {
                  if (!modifiers.additive) {
                    setSelection3d({ kind: 'member', id: hitMemberId });
                    return;
                  }
                  const selectedIds =
                    selection3d.kind === 'member'
                      ? [selection3d.id]
                      : selection3d.kind === 'members'
                        ? selection3d.ids
                        : [];
                  const ids = selectedIds.includes(hitMemberId)
                    ? selectedIds.filter((id) => id !== hitMemberId)
                    : [...selectedIds, hitMemberId];
                  setSelection3d(
                    ids.length === 0
                      ? { kind: 'none' }
                      : ids.length === 1
                        ? { kind: 'member', id: ids[0]! }
                        : { kind: 'members', ids },
                  );
                }
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
              failureCinematic={
                failurePhase !== undefined && rampFrame?.analysis.kind === 'stable'
                  ? { u: rampFrame.analysis.result.u, phase: failurePhase, reducedMotion }
                  : undefined
              }
            />
          )}
          {viewDimension === '3d' && model3d.members.length === 0 && (
            <div className="landing-invite" role="status">
              <p className="landing-invite-brand">Limit State</p>
              <p className="landing-invite-line">Draw on the workplane — or open a 3D preset.</p>
            </div>
          )}
          {viewDimension === '3d' && mode === 'build' && model3d.members.length > 0 && (
            <div className="demo3d-note" role="note">
              Extrude/Replicate to go spatial · Deck paints a traffic polyline · Stories: wind /
              traffic / EQ / ramp / pushover
            </div>
          )}
          {viewDimension === '3d' && mode === 'test' && (
            <TestConsole3d
              model={model3d}
              modalFreqHz={
                eigen3d?.modal.values[0] !== undefined
                  ? eigen3d.modal.values[0]! / (Math.PI * 2)
                  : undefined
              }
              bucklingLambda={eigen3d?.buckling.values[0]}
              playing={storyPlaying3d}
              storyTime={storyTime3d}
              traffic={trafficFrame3dActive}
              ramp={rampFrame3d}
              rampCapacity={capacity3d}
              pushover={pushover3d}
              earthquake={earthquakeFrame3d}
              wind={
                windFrame3d
                  ? {
                      daf: windFrame3d.daf,
                      resonanceMode: windFrame3d.resonanceMode,
                      coordinates: windFrame3d.coordinates,
                      modalFrequenciesHz: eigen3d?.modal.values
                        ? Array.from(eigen3d.modal.values).map((w) => w / (Math.PI * 2))
                        : undefined,
                    }
                  : undefined
              }
              onTogglePlayback={() => {
                if (model3d.story?.kind === 'traffic' && !model3d.deck?.length) {
                  setTrafficStory({});
                  return;
                }
                if (model3d.story?.kind === 'pushover') return;
                setStoryPlaying3d((playing) => !playing);
              }}
              onRestart={() => {
                setStoryPlaying3d(false);
                setStoryTime3d(0);
                setWindFrame3d(undefined);
                setTrafficFrame3d(undefined);
                setMovingMassFrame3d(undefined);
                setEarthquakeFrame3d(undefined);
              }}
              onSetStory={(kind: StorySpec3d['kind']) => {
                setStoryPlaying3d(false);
                setStoryTime3d(0);
                if (kind === 'wind') setWindStory({});
                else if (kind === 'traffic') setTrafficStory({});
                else if (kind === 'earthquake') setEarthquakeStory({});
                else if (kind === 'ramp') setRampStory();
                else setPushoverStory();
              }}
              onPatchTraffic={(partial) => setTrafficStory(partial)}
              onPatchWind={(partial) => setWindStory(partial)}
              onPatchEarthquake={(partial) => setEarthquakeStory(partial)}
              onReplayFailure={() => setFailureReplay3d((n) => n + 1)}
            />
          )}
          {viewDimension === '3d' && notice3d && (
            <div className="canvas-notice" role="status">
              {notice3d}
            </div>
          )}
          {viewDimension === '3d' && windFrame3d && analysis3d.kind === 'stable' && (
            <div className="dynamic-badge">
              3D Newmark wind — display scale ×
              {formatScale(deformationDisplay3d(analysis3d.mesh, windFrame3d.u, 44).scale)} ·
              direction{' '}
              {(model3d.story?.kind === 'wind' ? model3d.story.directionDeg : 0).toFixed(0)}° ·
              warping torsion still out of scope
            </div>
          )}
          {viewDimension === '3d' && earthquakeFrame3d && analysis3d.kind === 'stable' && (
            <div className="dynamic-badge">
              3D Newmark earthquake — display scale ×
              {formatScale(deformationDisplay3d(analysis3d.mesh, earthquakeFrame3d.u, 44).scale)} ·
              horizontal base excitation −M·ι·ü_g
            </div>
          )}
          {viewDimension === '3d' && trafficFrame3dActive?.analysis.kind === 'stable' && (
            <div className="dynamic-badge">
              {trafficFrame3dActive.movingMass
                ? `3D moving-mass Newmark — amp ×${trafficFrame3dActive.movingMass.amplification.toFixed(2)} vs static · vehicle mass lumped at axle contacts`
                : `3D traffic (quasi-static) — display scale ×${formatScale(deformationDisplay3d(trafficFrame3dActive.analysis.mesh, trafficFrame3dActive.analysis.result.u, 44).scale)} · two-axle polyline sweep`}
            </div>
          )}
          {viewDimension === '3d' && failurePhase3d !== undefined && (
            <div className="failure-cinematic-badge">
              failure animation ×
              {reducedMotion ? 'static' : formatScale(0.25 + failurePhase3d * 0.75)} — illustrative,
              computed onset and mechanism · quasi-static sequence — inertia not modeled
            </div>
          )}
          {viewDimension === '2d' && (
            <div className={`lint-badge lint-${stability.kind}`}>{stability.message}</div>
          )}
          {notice && viewDimension === '2d' && (
            <div className="canvas-notice" role="status">
              {notice}
            </div>
          )}
          {viewDimension === '2d' && activeChallengeId && (
            <ChallengePanel
              challengeId={activeChallengeId}
              model={model}
              analysisOptions={analysisOptions}
              onClear={() => setActiveChallenge(null)}
            />
          )}
          {(viewDimension === '2d' ? analysis.kind === 'stable' : analysis3d.kind === 'stable') && (
            <div className="result-controls" aria-label="Static result display">
              {viewDimension === '2d' &&
                (['none', 'axial', 'shear', 'moment'] as const).map((diagram) => (
                  <button
                    key={diagram}
                    type="button"
                    className={resultDiagram === diagram ? 'active' : ''}
                    onClick={() => setResultDiagram(diagram)}
                  >
                    {diagram === 'none' ? 'Results' : diagram[0]!.toUpperCase() + diagram.slice(1)}
                  </button>
                ))}
              {viewDimension === '3d' &&
                (['none', 'axial', 'shear', 'moment'] as const).map((diagram) => (
                  <button
                    key={`3d-${diagram}`}
                    type="button"
                    className={resultDiagram3d === diagram ? 'active' : ''}
                    onClick={() => setResultDiagram3d(diagram)}
                  >
                    {diagram === 'none' ? 'Results' : diagram[0]!.toUpperCase() + diagram.slice(1)}
                  </button>
                ))}
              <label>
                <input
                  type="checkbox"
                  checked={showDeformed}
                  onChange={(event) => setShowDeformed(event.target.checked)}
                />{' '}
                Deformed
              </label>
              {viewDimension === '2d' ? (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={shearFlexible}
                      onChange={(event) => setShearFlexible(event.target.checked)}
                    />{' '}
                    Timoshenko
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={secondOrder}
                      onChange={(event) => setSecondOrder(event.target.checked)}
                    />{' '}
                    P-Δ
                  </label>
                </>
              ) : (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={shearFlexible3d}
                      onChange={(event) => setShearFlexible3d(event.target.checked)}
                    />{' '}
                    Timoshenko
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={secondOrder3d}
                      onChange={(event) => setSecondOrder3d(event.target.checked)}
                    />{' '}
                    P-Δ
                  </label>
                </>
              )}
            </div>
          )}
          {viewDimension === '2d' && analysis.kind === 'stable' && analysis.secondOrder && (
            <div className="pdelta-badge" role="status">
              P-Δ ×{analysis.secondOrder.momentAmplification.toFixed(2)} moment · ×
              {analysis.secondOrder.displacementAmplification.toFixed(2)} disp vs linear (
              {analysis.secondOrder.iterations} iter)
            </div>
          )}
          {viewDimension === '3d' &&
            analysis3d.kind === 'stable' &&
            'momentAmplification' in analysis3d &&
            typeof analysis3d.momentAmplification === 'number' &&
            'displacementAmplification' in analysis3d &&
            typeof analysis3d.displacementAmplification === 'number' &&
            'iterations' in analysis3d &&
            typeof analysis3d.iterations === 'number' && (
              <div className="pdelta-badge" role="status">
                P-Δ ×{analysis3d.momentAmplification.toFixed(2)} moment · ×
                {analysis3d.displacementAmplification.toFixed(2)} disp vs linear (
                {analysis3d.iterations} iter)
              </div>
            )}
          {deformation && showDeformed && deformation.maxMeters > 0 && (
            <div className="deformation-badge">
              deformation ×{formatScale(deformation.scale)} — true max{' '}
              {formatLength(deformation.maxMeters)}
            </div>
          )}
          {viewDimension === '2d' && windFrame && (
            <div className="dynamic-badge">
              Newmark response — display scale ×
              {formatScale(deformationDisplay(windFrame.scenario.mesh, windFrame.u, 44).scale)} ·
              simplified uniform wind field (member-normal 2D pressure)
            </div>
          )}
          {viewDimension === '2d' && earthquakeFrame && (
            <div className="dynamic-badge">
              Newmark response — display scale ×
              {formatScale(
                deformationDisplay(earthquakeFrame.scenario.mesh, earthquakeFrame.u, 44).scale,
              )}{' '}
              · horizontal base excitation −M·ι·ü_g
            </div>
          )}
          {viewDimension === '2d' && movingMassFrame?.movingMass && (
            <div className="dynamic-badge">
              Moving-mass Newmark — amp ×{movingMassFrame.movingMass.amplification.toFixed(2)} vs
              static at this station · vehicle mass lumped at axle contacts
            </div>
          )}
          {viewDimension === '2d' && failurePhase !== undefined && (
            <div className="failure-cinematic-badge">
              failure animation ×
              {reducedMotion ? 'static' : formatScale(0.25 + failurePhase * 0.75)} — illustrative,
              computed onset and mechanism
            </div>
          )}
          {viewDimension === '2d' && model.members.length >= MEMBER_SOFT_LIMIT && (
            <div className="member-limit-badge">
              {model.members.length}/{MEMBER_HARD_LIMIT} members — performance warning at{' '}
              {MEMBER_SOFT_LIMIT}; hard cap {MEMBER_HARD_LIMIT}
            </div>
          )}
          {viewDimension === '3d' && model3d.members.length >= MEMBER_SOFT_LIMIT_3D && (
            <div className="member-limit-badge">
              {model3d.members.length}/{MEMBER_HARD_LIMIT_3D} members — line LOD forced above 64;
              eigen stays in the worker
            </div>
          )}
          {viewDimension === '3d' &&
            analysis3d.kind === 'stable' &&
            analysis3d.mesh.ndof > 1500 && (
              <div className="member-limit-badge">
                Modal/buckling solving in worker — {analysis3d.mesh.ndof} DOF; showing 4 modes for
                responsiveness.
              </div>
            )}
          {/* One column, so a shear note pushes the eigen panel down instead of
              being painted over by it. Anchored where the eigen panel sits alone,
              which keeps the note-free case unchanged. */}
          <div className="canvas-stack">
            {viewDimension === '2d' && analysis.kind === 'divergent' && (
              <div className="shear-note" role="alert">
                {analysis.message}
              </div>
            )}
            {viewDimension === '3d' && analysis3d.kind === 'divergent' && (
              <div className="shear-note" role="alert">
                {analysis3d.message}
              </div>
            )}
            {viewDimension === '2d' && stockyMembers.length > 0 && (
              <div className="shear-note" role="note">
                Shear flexibility matters when L/h &lt; 10 —{' '}
                {stockyMembers.length === 1
                  ? `member ${stockyMembers[0]} is`
                  : `${stockyMembers.length} members are`}{' '}
                stocky{shearFlexible ? '' : '; enable Timoshenko to include it'}.
              </div>
            )}
            {viewDimension === '3d' && stockyMembers3d.length > 0 && (
              <div className="shear-note" role="note">
                Shear flexibility matters when L/h &lt; 10 —{' '}
                {stockyMembers3d.length === 1
                  ? `member ${stockyMembers3d[0]} is`
                  : `${stockyMembers3d.length} members are`}{' '}
                stocky{shearFlexible3d ? '' : '; enable Timoshenko to include it'}.
              </div>
            )}
            {(viewDimension === '3d'
              ? analysis3d.kind === 'stable'
              : analysis.kind === 'stable') && (
              <div className="eigen-panel" aria-live="polite">
                <span>Modal + Buckling{viewDimension === '3d' ? ' (3D)' : ''}</span>
                {viewDimension === '2d' && eigen.kind === 'loading' && <p>Solving in worker…</p>}
                {viewDimension === '2d' && eigen.kind === 'error' && (
                  <p className="eigen-error">{eigen.message}</p>
                )}
                {viewDimension === '3d' && eigen3dState.kind === 'loading' && (
                  <p>Solving in worker…</p>
                )}
                {viewDimension === '3d' && eigen3dState.kind === 'error' && (
                  <p className="eigen-error">{eigen3dState.message}</p>
                )}
                {((viewDimension === '2d' && eigen.kind === 'ready') ||
                  (viewDimension === '3d' && eigen3d)) &&
                  activeEigen && (
                    <>
                      <div className="mode-family" aria-label="Mode shape family">
                        <button
                          type="button"
                          className={modeFamily === 'modal' ? 'active' : ''}
                          onClick={() => {
                            setModeFamily('modal');
                            setSelectedMode(0);
                          }}
                        >
                          Modal
                        </button>
                        <button
                          type="button"
                          className={modeFamily === 'buckling' ? 'active' : ''}
                          onClick={() => {
                            setModeFamily('buckling');
                            setSelectedMode(0);
                          }}
                        >
                          Buckling
                        </button>
                      </div>
                      <div className="mode-list" aria-label="Animated mode shapes">
                        {Array.from(activeEigen.values, (value, index) => (
                          <button
                            key={index}
                            type="button"
                            className={selectedMode === index ? 'active' : ''}
                            onClick={() => setSelectedMode(index)}
                          >
                            {modeFamily === 'modal'
                              ? `f${index + 1} ${(value / (Math.PI * 2)).toFixed(2)} Hz`
                              : `λ${index + 1} ${value.toFixed(2)}`}
                          </button>
                        ))}
                      </div>
                      <p>
                        {modeFamily === 'modal'
                          ? `mode shape normalized — ${reducedMotion ? 'static (reduced motion)' : `animating at ${(animationHz ?? 0).toFixed(2)} Hz${nativeAnimationHz && nativeAnimationHz > 2 ? ' (display slowed ×4)' : ''}`}`
                          : `buckling mode normalized — ${reducedMotion ? 'static (reduced motion)' : 'illustrative animation, not displacement'}`}
                      </p>
                      {viewDimension === '3d' &&
                        model3d.name === 'Slender deck' &&
                        modeFamily === 'modal' &&
                        selectedMode === 1 && (
                          <p className="honesty-note">
                            f₂ is St. Venant torsion (girders out of phase) — not aeroelastic
                            flutter; warping torsion out of scope.
                          </p>
                        )}
                      <p>
                        {(
                          viewDimension === '3d'
                            ? eigen3d?.buckling.values[0]
                            : eigen.kind === 'ready'
                              ? eigen.buckling.values[0]
                              : undefined
                        )
                          ? `λcr ${(viewDimension === '3d' ? eigen3d!.buckling.values[0]! : (eigen as { kind: 'ready'; buckling: EigenResult }).buckling.values[0]!).toFixed(2)} × reference load`
                          : 'No buckling under this load direction.'}
                      </p>
                    </>
                  )}
              </div>
            )}
          </div>
          {viewDimension === '2d' && mode === 'test' && (
            <TestConsole
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
                  try {
                    setMomentEnvelope(memberMomentEnvelopeFromInfluence(model, analysisOptions));
                  } catch {
                    setMomentEnvelope(new Map());
                  }
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
              onReplayFailure={() => {
                setStoryPlaying(false);
                setStoryTime(8);
                setFailureReplay((value) => value + 1);
              }}
              onReturn={() => setMode('build')}
            />
          )}
        </section>
        {viewDimension === '2d' ? <Inspector /> : <Inspector3d />}
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

interface WindFrame3d {
  scenario: WindScenario3d;
  t: number;
  u: Float64Array;
  coordinates?: Float64Array;
  daf?: { mode: number; ratio: number };
  resonanceMode?: number;
}

interface EarthquakeFrame3d {
  scenario: EarthquakeScenario3d;
  t: number;
  u: Float64Array;
  yieldMember?: number;
}

function scaleDisplacement3d(u: Float64Array, scale: number): Float64Array {
  const out = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = u[i]! * scale;
  return out;
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

/** Members with L/h < 10, where shear flexibility starts to matter. docs/FEM-SPEC.md §14 2A. */
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

/** 3D companion to the 2D L/h Timoshenko applicability note. */
function stockyMemberIds3d(model: EditorModel3d): number[] {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const stocky: number[] = [];
  for (const member of model.members) {
    const a = nodeById.get(member.a);
    const b = nodeById.get(member.b);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
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
