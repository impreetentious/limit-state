/**
 * Quasi-static two-axle traffic on a 3D deck polyline, with optional moving-mass
 * Newmark (2H cousin).
 */
import {
  newmarkStepAssembled,
  prepareNewmarkSystemAssembled,
  rayleighFit,
  type NewmarkState,
  type RayleighParams,
} from '../fem/dynamics';
import { assembleK3dDense, assembleLoadCase3d } from '../fem/space/assemble';
import {
  buildDeckRoute3d,
  deckLength3d,
  editorNodeIndex3d,
  mapDeckStation3d,
} from '../fem/space/deck';
import { modal3d } from '../fem/space/eigen';
import { buildMesh3d } from '../fem/space/mesh';
import {
  assembleMassWithVehicle3d,
  vehicleMassKg,
  type VehicleContact,
} from '../fem/space/moving-mass';
import {
  elementForcesAtDisplacement3d,
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
  /** Present when the frame came from moving-mass Newmark. */
  movingMass?: {
    dynamicMaxDisp: number;
    staticMaxDisp: number;
    amplification: number;
  };
}

export interface TrafficScenario3d {
  model: EditorModel3d;
  mesh: AnalysisMesh3d;
  route: ReturnType<typeof buildDeckRoute3d>;
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem3d;
  damping: RayleighParams;
  dt: number;
  K: Float64Array;
}

/** Build the deck route and factor K once. */
export function prepareTraffic3d(model: EditorModel3d): TrafficScenario3d {
  const mesh = buildMesh3d(model);
  const route = buildDeckRoute3d(model, mesh);
  let damping: RayleighParams = { a: 0, b: 0 };
  try {
    const modes = modal3d(mesh, 2);
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
    length: deckLength3d(route),
    nodeIndex: editorNodeIndex3d(mesh),
    system: prepareStaticSystem3d(mesh),
    damping,
    dt: 1 / 240,
    K: assembleK3dDense(mesh),
  };
}

export function analyzeTrafficAt3d(scenario: TrafficScenario3d, frontStation: number): TrafficFrame3d {
  const weightkN = scenario.model.story?.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  return analyzeTrafficAtWeight3d(scenario, frontStation, weightkN);
}

/**
 * Seed a moving-mass Newmark state from the quasi-static solution at the current station.
 */
export function initialMovingMassState3d(scenario: TrafficScenario3d, frontStation: number): NewmarkState {
  const frame = analyzeTrafficAt3d(scenario, frontStation);
  const u = frame.analysis.kind === 'stable'
    ? new Float64Array(frame.analysis.result.u)
    : new Float64Array(scenario.mesh.ndof);
  const speed = scenario.model.story?.kind === 'traffic' ? scenario.model.story.speed : 1;
  return {
    u,
    v: new Float64Array(scenario.mesh.ndof),
    a: new Float64Array(scenario.mesh.ndof),
    t: frontStation / Math.max(0.1, speed),
    damping: scenario.damping,
  };
}

/**
 * Advance moving-mass traffic with M(t) rebuilt at each axle station.
 */
export function stepMovingMassTraffic3d(
  scenario: TrafficScenario3d,
  state: NewmarkState,
  substeps = 4,
): { state: NewmarkState; frame: TrafficFrame3d } {
  const speed = scenario.model.story?.kind === 'traffic' ? Math.max(0.1, scenario.model.story.speed) : 12;
  let current = state;
  for (let step = 0; step < substeps; step++) {
    const nextTime = current.t + scenario.dt;
    const frontStation = nextTime * speed;
    const contacts = vehicleContactsAt3d(scenario, frontStation);
    const mass = assembleMassWithVehicle3d(scenario.mesh, contacts);
    const system = prepareNewmarkSystemAssembled(
      scenario.mesh,
      scenario.K,
      mass,
      scenario.dt,
      scenario.damping,
    );
    current = newmarkStepAssembled(
      scenario.mesh,
      current,
      (t) => trafficLoadCase3d(scenario, t * speed, scenario.model.story?.kind === 'traffic' ? scenario.model.story.weightkN : 0).F,
      scenario.dt,
      scenario.damping,
      system,
    );
    current = { ...current, system: undefined };
  }
  const frontStation = current.t * speed;
  const frame = trafficFrameFromDisplacement3d(scenario, frontStation, current.u);
  return { state: current, frame };
}

function analyzeTrafficAtWeight3d(
  scenario: TrafficScenario3d,
  frontStation: number,
  weightkN: number,
): TrafficFrame3d {
  try {
    const loads = trafficLoadCase3d(scenario, frontStation, weightkN);
    const mapped = axleHits3d(scenario, frontStation);
    const solved = solveStatic3d(scenario.mesh, loads.F, scenario.system, loads.elementFixedEnd);
    if (solved.kind !== 'stable') {
      return { analysis: solved, length: scenario.length, axles: mapped.map(toAxle) };
    }
    return {
      analysis: solved,
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

function trafficFrameFromDisplacement3d(
  scenario: TrafficScenario3d,
  frontStation: number,
  u: Float64Array,
): TrafficFrame3d {
  const weightkN = scenario.model.story?.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  const loads = trafficLoadCase3d(scenario, frontStation, weightkN);
  const mapped = axleHits3d(scenario, frontStation);
  const staticFrame = analyzeTrafficAtWeight3d(scenario, frontStation, weightkN);
  const utilization = utilizationAtDisplacement3d(scenario.mesh, u, loads.elementFixedEnd);
  const forces = elementForcesAtDisplacement3d(scenario.mesh, u, loads.elementFixedEnd);
  const analysis: StaticAnalysis3d = {
    kind: 'stable',
    mesh: scenario.mesh,
    result: { u, reactions: new Map(), elementForces: forces, utilization },
  };
  const dynamicMaxDisp = maxNodalDisp3d(u);
  const staticMaxDisp = staticFrame.analysis.kind === 'stable' ? maxNodalDisp3d(staticFrame.analysis.result.u) : 0;
  return {
    analysis,
    length: scenario.length,
    axles: mapped.map(toAxle),
    movingMass: {
      dynamicMaxDisp,
      staticMaxDisp,
      amplification: staticMaxDisp > 1e-15 ? dynamicMaxDisp / staticMaxDisp : 1,
    },
  };
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

export function vehicleContactsAt3d(scenario: TrafficScenario3d, frontStation: number): VehicleContact[] {
  const weightkN = scenario.model.story?.kind === 'traffic' ? scenario.model.story.weightkN : 0;
  const axleMass = vehicleMassKg(weightkN) / 2;
  return axleHits3d(scenario, frontStation).map((hit) => ({
    element: hit.element,
    xi: hit.xi,
    massKg: axleMass,
  }));
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

function maxNodalDisp3d(u: Float64Array): number {
  let maximum = 0;
  for (let node = 0; u.length > node * 6; node++) {
    maximum = Math.max(maximum, Math.hypot(u[6 * node]!, u[6 * node + 1]!, u[6 * node + 2]!));
  }
  return maximum;
}

/**
 * Merge per-member combined bending magnitude |M| = √(My² + Mz²) across a
 * quasi-static station sweep into a persistent moving-load envelope.
 */
export function mergeMomentEnvelope3d(
  previous: ReadonlyMap<number, number>,
  analysis: StaticAnalysis3d,
): Map<number, number> {
  const next = new Map(previous);
  if (analysis.kind !== 'stable') return next;
  const mesh = analysis.mesh;
  const forces = analysis.result.elementForces;
  for (let index = 0; index < mesh.elements.length; index++) {
    const memberId = mesh.elements[index]!.memberId;
    const base = index * 12;
    const magA = Math.hypot(forces[base + 4]!, forces[base + 5]!);
    const magB = Math.hypot(forces[base + 10]!, forces[base + 11]!);
    const worst = Math.max(magA, magB);
    next.set(memberId, Math.max(next.get(memberId) ?? 0, worst));
  }
  return next;
}

/**
 * Sweep the traffic vehicle across the deck at fixed spacing and return the
 * moving-load |M| envelope per member.
 */
export function trafficMomentEnvelope3d(
  scenario: TrafficScenario3d,
  stepMeters?: number,
): Map<number, number> {
  const step = stepMeters ?? Math.max(scenario.length / 40, 0.5);
  let envelope: Map<number, number> = new Map();
  const stations: number[] = [];
  for (let s = 0; s <= scenario.length + 1e-9; s += step) stations.push(Math.min(s, scenario.length));
  if (stations.length === 0 || stations[stations.length - 1]! < scenario.length) stations.push(scenario.length);
  for (const station of stations) {
    const frame = analyzeTrafficAt3d(scenario, station);
    envelope = mergeMomentEnvelope3d(envelope, frame.analysis);
  }
  return envelope;
}
