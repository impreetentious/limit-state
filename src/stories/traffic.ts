/**
 * Quasi-static two-axle traffic controller. It maps continuous deck stations
 * onto the consistent in-element load vectors, so the truck never jumps node
 * to node.
 */
import { assembleLoadCase } from '../fem/assemble';
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
  route: DeckSegment[];
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem;
}

interface DeckSegment {
  memberId: number;
  startNode: number;
  endNode: number;
  length: number;
  elements: Array<{ index: number; reversed: boolean }>;
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
  const route = deckRoute(model, mesh);
  return {
    model,
    mesh,
    route,
    length: route.reduce((sum, segment) => sum + segment.length, 0),
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
    const mapped = axleStations.flatMap((station) => mapStation(model, mesh, route, station));
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

function deckRoute(model: EditorModel, mesh: AnalysisMesh): DeckSegment[] {
  if (model.deck.length === 0) throw new Error('Paint a contiguous deck before running traffic.');
  const members = new Map(model.members.map((member) => [member.id, member]));
  const first = members.get(model.deck[0]!);
  if (!first) throw new Error('Deck references a missing member.');
  let current = first.a;
  if (model.deck.length > 1) {
    const next = members.get(model.deck[1]!);
    if (!next) throw new Error('Deck references a missing member.');
    const shared = [first.a, first.b].find((node) => node === next.a || node === next.b);
    if (shared !== undefined) current = current === shared ? first.b : first.a;
  }
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const route: DeckSegment[] = [];
  for (const id of model.deck) {
    const member = members.get(id);
    if (!member) throw new Error('Deck references a missing member.');
    const reversed = member.b === current;
    if (!reversed && member.a !== current) throw new Error('Deck members must form one continuous route.');
    const startNode = current;
    const endNode = reversed ? member.a : member.b;
    const start = nodeById.get(startNode);
    const end = nodeById.get(endNode);
    if (!start || !end) throw new Error('Deck references a missing node.');
    const elementIndices = mesh.elements.flatMap((element, index) => element.memberId === id ? [index] : []);
    route.push({
      memberId: id,
      startNode,
      endNode,
      length: Math.hypot(end.x - start.x, end.y - start.y),
      elements: (reversed ? [...elementIndices].reverse() : elementIndices).map((index) => ({ index, reversed })),
    });
    current = endNode;
  }
  return route;
}

function mapStation(
  model: EditorModel,
  mesh: AnalysisMesh,
  route: DeckSegment[],
  station: number,
): Array<{ station: number; element: number; xi: number; x: number; y: number }> {
  if (station < 0) return [];
  let remaining = station;
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  for (const segment of route) {
    if (remaining > segment.length) {
      remaining -= segment.length;
      continue;
    }
    const start = nodes.get(segment.startNode)!;
    const end = nodes.get(segment.endNode)!;
    const fraction = segment.length === 0 ? 0 : remaining / segment.length;
    let withinMember = remaining;
    for (const item of segment.elements) {
      const element = mesh.elements[item.index]!;
      if (withinMember <= element.L || item === segment.elements.at(-1)) {
        const localFraction = Math.max(0, Math.min(1, withinMember / element.L));
        return [{
          station,
          element: item.index,
          xi: item.reversed ? 1 - localFraction : localFraction,
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
        }];
      }
      withinMember -= element.L;
    }
    return [];
  }
  return [];
}

function editorNodeIndex(mesh: AnalysisMesh): Map<number, number> {
  const index = new Map<number, number>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const id = mesh.editorNode[node]!;
    if (id >= 0) index.set(id, node);
  }
  return index;
}
