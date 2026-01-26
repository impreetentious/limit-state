/**
 * Quasi-static two-axle traffic on a 3D deck polyline.
 * Axle spacing 4 m, weight along −Z.
 */
import { assembleLoadCase3d } from '../fem/space/assemble';
import {
  buildDeckRoute3d,
  deckLength3d,
  editorNodeIndex3d,
  mapDeckStation3d,
} from '../fem/space/deck';
import { buildMesh3d } from '../fem/space/mesh';
import {
  prepareStaticSystem3d,
  solveStatic3d,
  utilizationAtDisplacement3d,
  type StaticAnalysis3d,
  type StaticSystem3d,
} from '../fem/space/statics';
import type { AnalysisMesh3d, EditorModel3d } from '../fem/space/types';

export interface TrafficAxle3d {
  station: number;
  x: number;
  y: number;
  z: number;
}

export interface TrafficFrame3d {
  analysis: StaticAnalysis3d;
  length: number;
  axles: TrafficAxle3d[];
}

export interface TrafficScenario3d {
  model: EditorModel3d;
  mesh: AnalysisMesh3d;
  route: ReturnType<typeof buildDeckRoute3d>;
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem3d;
}

/** Build the deck route and factor K once. */
export function prepareTraffic3d(model: EditorModel3d): TrafficScenario3d {
  const mesh = buildMesh3d(model);
  const route = buildDeckRoute3d(model, mesh);
  return {
    model,
    mesh,
    route,
    length: deckLength3d(route),
    nodeIndex: editorNodeIndex3d(mesh),
    system: prepareStaticSystem3d(mesh),
  };
}

export function analyzeTrafficAt3d(scenario: TrafficScenario3d, frontStation: number): TrafficFrame3d {
  const weightkN = scenario.model.story?.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  return analyzeTrafficAtWeight3d(scenario, frontStation, weightkN);
}

function analyzeTrafficAtWeight3d(
  scenario: TrafficScenario3d,
  frontStation: number,
  weightkN: number,
): TrafficFrame3d {
  try {
    const loads = trafficLoadCase3d(scenario, frontStation, weightkN);
    const mapped = axleHits3d(scenario, frontStation);
    const solved = solveStatic3d(scenario.mesh, loads.F, scenario.system);
    if (solved.kind !== 'stable') {
      return { analysis: solved, length: scenario.length, axles: mapped.map(toAxle) };
    }
    const utilization = utilizationAtDisplacement3d(scenario.mesh, solved.result.u, loads.elementFixedEnd);
    return {
      analysis: {
        ...solved,
        result: { ...solved.result, utilization },
      },
      length: scenario.length,
      axles: mapped.map(toAxle),
    };
  } catch (error) {
    return {
      analysis: {
        kind: 'invalid',
        message: error instanceof Error ? error.message : '3D traffic analysis could not run.',
      },
      length: 0,
      axles: [],
    };
  }
}

function trafficLoadCase3d(scenario: TrafficScenario3d, frontStation: number, weightkN: number) {
  const { model, mesh, nodeIndex } = scenario;
  const mapped = axleHits3d(scenario, frontStation);
  const points = model.loads.points.flatMap((point) => {
    const meshNode = nodeIndex.get(point.node);
    return meshNode === undefined
      ? []
      : [{ meshNode, fx: point.fx, fy: point.fy, fz: point.fz, mx: point.mx, my: point.my, mz: point.mz }];
  });
  const axleForce = Math.max(0, weightkN) * 1000 / 2;
  return assembleLoadCase3d(mesh, {
    points,
    inElement: mapped.map((axle) => ({
      element: axle.element,
      xi: axle.xi,
      fx: 0,
      fy: 0,
      fz: -axleForce,
    })),
  });
}

function axleHits3d(scenario: TrafficScenario3d, frontStation: number) {
  const { model, mesh, route } = scenario;
  return [frontStation, frontStation - 4].flatMap((station) =>
    mapDeckStation3d(model, mesh, route, station),
  );
}

function toAxle(hit: { station: number; x: number; y: number; z: number }): TrafficAxle3d {
  return { station: hit.station, x: hit.x, y: hit.y, z: hit.z };
}
