/**
 * Quasi-static two-axle traffic controller. It maps continuous deck stations
 * onto the consistent in-element load vectors, so the truck never jumps node
 * to node.
 */
import { assembleLoadCase } from '../fem/assemble';
import { buildDeckRoute, deckLength, editorNodeIndex, mapDeckStation } from '../fem/deck';
import { buildMesh } from '../fem/mesh';
import { prepareStaticSystem, solveStatic, type StaticAnalysis, type StaticSystem } from '../fem/statics';
import type { AnalysisMesh, AnalysisOptions, EditorModel } from '../fem/types';

export interface TrafficAxle {
  station: number;
  x: number;
  y: number;
}

export interface TrafficFrame {
  analysis: StaticAnalysis;
  length: number;
  axles: TrafficAxle[];
}

/** Yield-only vehicle capacity at one deck station, found with the same cached static solver. */
export function trafficYieldWeightAt(scenario: TrafficScenario, frontStation: number): number | undefined {
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
  if (upperFrame.analysis.kind !== 'stable' || maximumUtilization(upperFrame.analysis) < 1) return undefined;
  for (let iteration = 0; iteration < 36; iteration++) {
    const middle = (lower + upper) / 2;
    const frame = analyzeTrafficAtWeight(scenario, frontStation, middle);
    if (frame.analysis.kind !== 'stable') return undefined;
    if (maximumUtilization(frame.analysis) >= 1) upper = middle;
    else lower = middle;
  }
  return upper;
}

/** Cached mesh/factorization for one moving-load sweep. */
export interface TrafficScenario {
  model: EditorModel;
  mesh: AnalysisMesh;
  route: ReturnType<typeof buildDeckRoute>;
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem;
}

/** Solve the model under two W/2 axles separated by four metres. */
export function analyzeTraffic(model: EditorModel, frontStation: number, options: AnalysisOptions = {}): TrafficFrame {
  try {
    return analyzeTrafficAt(prepareTraffic(model, options), frontStation);
  } catch (error) {
    return {
      analysis: { kind: 'invalid', message: error instanceof Error ? error.message : 'Traffic analysis could not run.' },
      length: 0,
      axles: [],
    };
  }
}

/** Build the deck route and factor the fixed stiffness once per model edit. */
export function prepareTraffic(model: EditorModel, options: AnalysisOptions = {}): TrafficScenario {
  const mesh = buildMesh(model, options);
  const route = buildDeckRoute(model, mesh);
  return {
    model,
    mesh,
    route,
    length: deckLength(route),
    nodeIndex: editorNodeIndex(mesh),
    system: prepareStaticSystem(mesh),
  };
}

/** Re-solve a cached traffic deck with a new axle station. */
export function analyzeTrafficAt(scenario: TrafficScenario, frontStation: number): TrafficFrame {
  const weightkN = scenario.model.story.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  return analyzeTrafficAtWeight(scenario, frontStation, weightkN);
}

function analyzeTrafficAtWeight(scenario: TrafficScenario, frontStation: number, weightkN: number): TrafficFrame {
  try {
    const { model, mesh, route, length, nodeIndex, system } = scenario;
    const axleStations = [frontStation, frontStation - 4];
    const mapped = axleStations.flatMap((station) => mapDeckStation(model, mesh, route, station));
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined ? [] : [{ meshNode, fx: point.fx, fy: point.fy }];
    });
    const axleForce = Math.max(0, weightkN) * 1000 / 2;
    const loads = assembleLoadCase(mesh, {
      gravity: model.loads.gravity,
      points,
      inElement: mapped.map((axle) => ({ element: axle.element, xi: axle.xi, p: axleForce })),
    });
    return {
      analysis: solveStatic(mesh, loads, system),
      length,
      axles: mapped.map((axle) => ({ station: axle.station, x: axle.x, y: axle.y })),
    };
  } catch (error) {
    return {
      analysis: { kind: 'invalid', message: error instanceof Error ? error.message : 'Traffic analysis could not run.' },
      length: 0,
      axles: [],
    };
  }
}

function maximumUtilization(analysis: Extract<StaticAnalysis, { kind: 'stable' }>): number {
  let maximum = 0;
  for (const utilization of analysis.result.utilization.values()) maximum = Math.max(maximum, utilization);
  return maximum;
}

/** Merge per-member maximum |M| values into a persistent moving-load envelope. */
export function mergeMomentEnvelope(previous: ReadonlyMap<number, number>, analysis: StaticAnalysis): Map<number, number> {
  const next = new Map(previous);
  if (analysis.kind !== 'stable') return next;
  for (let index = 0; index < analysis.mesh.elements.length; index++) {
    const memberId = analysis.mesh.elements[index]!.memberId;
    const moment = Math.max(Math.abs(analysis.result.elementForces[index * 5 + 2]!), Math.abs(analysis.result.elementForces[index * 5 + 4]!));
    next.set(memberId, Math.max(next.get(memberId) ?? 0, moment));
  }
  return next;
}
