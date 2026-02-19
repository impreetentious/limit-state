/**
 * Two-axle traffic controller: quasi-static by default, optional moving-mass
 * Newmark when `story.movingMass` is set. docs/FEM-SPEC.md §4.2, §6.3, and §14 2H.
 */
import { assembleLoadCase } from '../fem/assemble';
import { buildDeckRoute, deckLength, editorNodeIndex, mapDeckStation } from '../fem/deck';
import { modal } from '../fem/eigen';
import { newmarkStep, rayleighFit, type NewmarkState, type RayleighParams } from '../fem/dynamics';
import { assembleMassWithVehicle, vehicleMassKg, type VehicleContact } from '../fem/moving-mass';
import { buildMesh } from '../fem/mesh';
import {
  elementForcesAtDisplacement,
  prepareStaticSystem,
  solveStatic,
  utilizationAtDisplacement,
  type StaticAnalysis,
  type StaticSystem,
} from '../fem/statics';
import type { AnalysisMesh, AnalysisOptions, EditorModel } from '../fem/types';

interface TrafficAxle {
  station: number;
  x: number;
  y: number;
}

export interface TrafficFrame {
  analysis: StaticAnalysis;
  length: number;
  axles: TrafficAxle[];
  /** Present when the frame came from moving-mass Newmark. docs/FEM-SPEC.md §14 2H. */
  movingMass?: {
    dynamicMaxDisp: number;
    staticMaxDisp: number;
    amplification: number;
  };
}

/** Yield-only vehicle capacity at one deck station, found with the same cached static solver. docs/FEM-SPEC.md §6.3 and §6.6. */
export function trafficYieldWeightAt(
  scenario: TrafficScenario,
  frontStation: number,
): number | undefined {
  if (!(frontStation > 0)) return undefined;
  const baseline = analyzeTrafficAtWeight(scenario, frontStation, 0).analysis;
  if (baseline.kind !== 'stable') return undefined;
  if (maximumUtilization(baseline) >= 1) return 0;
  const initial = scenario.model.story.kind === 'traffic' ? scenario.model.story.weightkN : 300;
  let lower = 0;
  let upper = Math.max(10, initial);
  for (let iteration = 0; iteration < 12; iteration++) {
    const frame = analyzeTrafficAtWeight(scenario, frontStation, upper);
    if (frame.analysis.kind !== 'stable') return undefined;
    if (maximumUtilization(frame.analysis) >= 1) break;
    lower = upper;
    upper *= 2;
  }
  const upperFrame = analyzeTrafficAtWeight(scenario, frontStation, upper);
  if (upperFrame.analysis.kind !== 'stable' || maximumUtilization(upperFrame.analysis) < 1)
    return undefined;
  for (let iteration = 0; iteration < 36; iteration++) {
    const middle = (lower + upper) / 2;
    const frame = analyzeTrafficAtWeight(scenario, frontStation, middle);
    if (frame.analysis.kind !== 'stable') return undefined;
    if (maximumUtilization(frame.analysis) >= 1) upper = middle;
    else lower = middle;
  }
  return upper;
}

/** Cached mesh/factorization for one moving-load sweep. docs/FEM-SPEC.md §6.3 / §14 2H. */
export interface TrafficScenario {
  model: EditorModel;
  mesh: AnalysisMesh;
  route: ReturnType<typeof buildDeckRoute>;
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem;
  /** Rayleigh fit for moving-mass Newmark (ζ = 2%). docs/FEM-SPEC.md §14 2H. */
  damping: RayleighParams;
  dt: number;
}

/** Solve the model under two W/2 axles separated by four metres. docs/FEM-SPEC.md §4.2 and §6.3. */
export function analyzeTraffic(
  model: EditorModel,
  frontStation: number,
  options: AnalysisOptions = {},
): TrafficFrame {
  try {
    return analyzeTrafficAt(prepareTraffic(model, options), frontStation);
  } catch (error) {
    return {
      analysis: {
        kind: 'invalid',
        message: error instanceof Error ? error.message : 'Traffic analysis could not run.',
      },
      length: 0,
      axles: [],
    };
  }
}

/** Build the deck route and factor the fixed stiffness once per model edit. docs/FEM-SPEC.md §6.3 / §14 2H. */
export function prepareTraffic(model: EditorModel, options: AnalysisOptions = {}): TrafficScenario {
  const mesh = buildMesh(model, options);
  const route = buildDeckRoute(model, mesh);
  let damping: RayleighParams = { a: 0, b: 0 };
  try {
    const modes = modal(mesh, 2);
    const w1 = modes.values[0] ?? 1;
    const w2 = modes.values[1] ?? w1 * 3;
    damping = rayleighFit(0.02, w1, w2);
  } catch {
    damping = rayleighFit(0.02, 2 * Math.PI * 0.5, 2 * Math.PI * 2);
  }
  return {
    model,
    mesh,
    route,
    length: deckLength(route),
    nodeIndex: editorNodeIndex(mesh),
    system: prepareStaticSystem(mesh),
    damping,
    dt: 1 / 240,
  };
}

/** Re-solve a cached traffic deck with a new axle station (quasi-static). docs/FEM-SPEC.md §4.2 and §6.3. */
export function analyzeTrafficAt(scenario: TrafficScenario, frontStation: number): TrafficFrame {
  const weightkN = scenario.model.story.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  return analyzeTrafficAtWeight(scenario, frontStation, weightkN);
}

/**
 * Seed a moving-mass Newmark state from the quasi-static solution at the current station.
 * docs/FEM-SPEC.md §14 2H.
 */
export function initialMovingMassState(
  scenario: TrafficScenario,
  frontStation: number,
): NewmarkState {
  const frame = analyzeTrafficAt(scenario, frontStation);
  const u =
    frame.analysis.kind === 'stable'
      ? new Float64Array(frame.analysis.result.u)
      : new Float64Array(scenario.mesh.ndof);
  const speed = scenario.model.story.kind === 'traffic' ? scenario.model.story.speed : 1;
  return {
    u,
    v: new Float64Array(scenario.mesh.ndof),
    a: new Float64Array(scenario.mesh.ndof),
    t: frontStation / Math.max(0.1, speed),
    damping: scenario.damping,
  };
}

/**
 * Advance moving-mass traffic by `substeps` Newmark steps with M(t) updated at
 * each axle station. docs/FEM-SPEC.md §14 2H.
 */
export function stepMovingMassTraffic(
  scenario: TrafficScenario,
  state: NewmarkState,
  substeps = 4,
): { state: NewmarkState; frame: TrafficFrame } {
  const speed =
    scenario.model.story.kind === 'traffic' ? Math.max(0.1, scenario.model.story.speed) : 12;
  let current = state;
  for (let step = 0; step < substeps; step++) {
    const nextTime = current.t + scenario.dt;
    const frontStation = nextTime * speed;
    const contacts = vehicleContactsAt(scenario, frontStation);
    const mass = assembleMassWithVehicle(scenario.mesh, contacts);
    current = newmarkStep(
      scenario.mesh,
      current,
      (t) => trafficLoadVector(scenario, t * speed).F,
      scenario.dt,
      scenario.damping,
      mass,
    );
  }
  const frontStation = current.t * speed;
  const frame = trafficFrameFromDisplacement(scenario, frontStation, current.u);
  return { state: current, frame };
}

function analyzeTrafficAtWeight(
  scenario: TrafficScenario,
  frontStation: number,
  weightkN: number,
): TrafficFrame {
  try {
    const loads = trafficLoadCase(scenario, frontStation, weightkN);
    const mapped = axleHits(scenario, frontStation);
    return {
      analysis: solveStatic(scenario.mesh, loads, scenario.system),
      length: scenario.length,
      axles: mapped.map((axle) => ({ station: axle.station, x: axle.x, y: axle.y })),
    };
  } catch (error) {
    return {
      analysis: {
        kind: 'invalid',
        message: error instanceof Error ? error.message : 'Traffic analysis could not run.',
      },
      length: 0,
      axles: [],
    };
  }
}

function trafficFrameFromDisplacement(
  scenario: TrafficScenario,
  frontStation: number,
  u: Float64Array,
): TrafficFrame {
  const weightkN = scenario.model.story.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  const loads = trafficLoadCase(scenario, frontStation, weightkN);
  const mapped = axleHits(scenario, frontStation);
  const staticFrame = analyzeTrafficAtWeight(scenario, frontStation, weightkN);
  const utilization = utilizationAtDisplacement(scenario.mesh, u, loads.elementFixedEnd);
  const forces = elementForcesAtDisplacement(scenario.mesh, u, loads.elementFixedEnd);
  const analysis: StaticAnalysis = {
    kind: 'stable',
    mesh: scenario.mesh,
    result: { u, reactions: new Map(), elementForces: forces, utilization },
    loads,
  };
  const dynamicMaxDisp = maxNodalDisp(u);
  const staticMaxDisp =
    staticFrame.analysis.kind === 'stable' ? maxNodalDisp(staticFrame.analysis.result.u) : 0;
  return {
    analysis,
    length: scenario.length,
    axles: mapped.map((axle) => ({ station: axle.station, x: axle.x, y: axle.y })),
    movingMass: {
      dynamicMaxDisp,
      staticMaxDisp,
      amplification: staticMaxDisp > 1e-15 ? dynamicMaxDisp / staticMaxDisp : 1,
    },
  };
}

function trafficLoadVector(
  scenario: TrafficScenario,
  frontStation: number,
): ReturnType<typeof assembleLoadCase> {
  const weightkN = scenario.model.story.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  return trafficLoadCase(scenario, frontStation, weightkN);
}

function trafficLoadCase(scenario: TrafficScenario, frontStation: number, weightkN: number) {
  const { model, mesh, nodeIndex } = scenario;
  const mapped = axleHits(scenario, frontStation);
  const points = model.loads.points.flatMap((point) => {
    const meshNode = nodeIndex.get(point.node);
    return meshNode === undefined ? [] : [{ meshNode, fx: point.fx, fy: point.fy }];
  });
  const axleForce = (Math.max(0, weightkN) * 1000) / 2;
  return assembleLoadCase(mesh, {
    gravity: model.loads.gravity,
    points,
    inElement: mapped.map((axle) => ({ element: axle.element, xi: axle.xi, p: axleForce })),
  });
}

/** Axle contacts with equal share of vehicle mass. docs/FEM-SPEC.md §14 2H. */
export function vehicleContactsAt(
  scenario: TrafficScenario,
  frontStation: number,
): VehicleContact[] {
  const weightkN = scenario.model.story.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  const axleMass = vehicleMassKg(weightkN) / 2;
  return axleHits(scenario, frontStation).map((hit) => ({
    element: hit.element,
    xi: hit.xi,
    massKg: axleMass,
  }));
}

function axleHits(scenario: TrafficScenario, frontStation: number) {
  const { model, mesh, route } = scenario;
  const axleStations = [frontStation, frontStation - 4];
  return axleStations.flatMap((station) => mapDeckStation(model, mesh, route, station));
}

function maximumUtilization(analysis: Extract<StaticAnalysis, { kind: 'stable' }>): number {
  let maximum = 0;
  for (const utilization of analysis.result.utilization.values())
    maximum = Math.max(maximum, utilization);
  return maximum;
}

function maxNodalDisp(u: Float64Array): number {
  let maximum = 0;
  for (let node = 0; u.length > node * 3; node++) {
    maximum = Math.max(maximum, Math.hypot(u[3 * node]!, u[3 * node + 1]!));
  }
  return maximum;
}

/** Merge per-member maximum |M| values into a persistent moving-load envelope. docs/FEM-SPEC.md §6.3. */
export function mergeMomentEnvelope(
  previous: ReadonlyMap<number, number>,
  analysis: StaticAnalysis,
): Map<number, number> {
  const next = new Map(previous);
  if (analysis.kind !== 'stable') return next;
  for (let index = 0; index < analysis.mesh.elements.length; index++) {
    const memberId = analysis.mesh.elements[index]!.memberId;
    const moment = Math.max(
      Math.abs(analysis.result.elementForces[index * 5 + 2]!),
      Math.abs(analysis.result.elementForces[index * 5 + 4]!),
    );
    next.set(memberId, Math.max(next.get(memberId) ?? 0, moment));
  }
  return next;
}
