/**
 * 3D influence lines: unit downward (−Z) load swept along the deck polyline,
 * response quantity read per station. Parallel to 2D `fem/influence.ts`.
 */
import { assembleLoadCase3d } from './assemble';
import { buildDeckRoute3d, deckLength3d, editorNodeIndex3d, mapDeckStation3d, type DeckSegment3d } from './deck';
import { buildMesh3d } from './mesh';
import { prepareStaticSystem3d, solveStatic3d, type StaticSystem3d } from './statics';
import type { AnalysisMesh3d, EditorModel3d, StaticResult3d } from './types';

/** Response quantity whose influence line is traced by a unit −Z deck load. */
export type InfluenceQuantity3d =
  | { kind: 'reaction'; nodeId: number; component: 'fx' | 'fy' | 'fz' | 'mx' | 'my' | 'mz' }
  | { kind: 'axial'; memberId: number }
  /** Section bending magnitude at end or midpoint: √(My² + Mz²) with 'moment' at 'a'|'b'|'mid'. */
  | { kind: 'moment'; memberId: number; at: 'a' | 'b' | 'mid'; axis?: 'y' | 'z' | 'mag' };

export interface InfluenceSample3d {
  station: number;
  x: number;
  y: number;
  z: number;
  value: number;
}

export interface InfluenceLine3d {
  quantity: InfluenceQuantity3d;
  length: number;
  samples: InfluenceSample3d[];
  peak: { station: number; value: number };
}

export interface InfluenceScenario3d {
  model: EditorModel3d;
  mesh: AnalysisMesh3d;
  route: DeckSegment3d[];
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem3d;
}

export interface InfluenceEnvelope3d {
  maxAbs: number;
  criticalStation: number;
}

/** Factor the deck once. */
export function prepareInfluence3d(model: EditorModel3d): InfluenceScenario3d {
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

/** Compute a full unit-load sweep. */
export function computeInfluenceLine3d(
  model: EditorModel3d,
  quantity: InfluenceQuantity3d,
  options: { step?: number } = {},
): InfluenceLine3d {
  return computeInfluenceLineAt3d(prepareInfluence3d(model), quantity, options.step);
}

/** Re-use a prepared scenario. */
export function computeInfluenceLineAt3d(
  scenario: InfluenceScenario3d,
  quantity: InfluenceQuantity3d,
  stepMeters?: number,
): InfluenceLine3d {
  const step = stepMeters ?? Math.max(scenario.length / 40, 1e-6);
  const samples: InfluenceSample3d[] = [];
  for (let station = 0; station <= scenario.length + 1e-12; station += step) {
    const clamped = Math.min(station, scenario.length);
    const sample = sampleInfluenceAt3d(scenario, clamped, quantity);
    if (sample) samples.push(sample);
    if (clamped === scenario.length) break;
  }
  if (samples.length === 0 || samples[samples.length - 1]!.station < scenario.length - 1e-12) {
    const end = sampleInfluenceAt3d(scenario, scenario.length, quantity);
    if (end) samples.push(end);
  }
  let peak = samples[0] ?? { station: 0, value: 0 };
  for (const sample of samples) if (Math.abs(sample.value) > Math.abs(peak.value)) peak = sample;
  return { quantity, length: scenario.length, samples, peak: { station: peak.station, value: peak.value } };
}

/** Unit −Z-load response at one deck station. */
export function sampleInfluenceAt3d(
  scenario: InfluenceScenario3d,
  station: number,
  quantity: InfluenceQuantity3d,
): InfluenceSample3d | undefined {
  const hits = mapDeckStation3d(scenario.model, scenario.mesh, scenario.route, station);
  if (hits.length === 0) return undefined;
  const hit = hits[0]!;
  const loads = assembleLoadCase3d(scenario.mesh, {
    inElement: [{ element: hit.element, xi: hit.xi, fx: 0, fy: 0, fz: -1 }],
  });
  const analysis = solveStatic3d(scenario.mesh, loads.F, scenario.system, loads.elementFixedEnd);
  if (analysis.kind !== 'stable') return undefined;
  return {
    station: hit.station,
    x: hit.x,
    y: hit.y,
    z: hit.z,
    value: readQuantity3d(scenario.mesh, analysis.result, quantity, hit.element),
  };
}

/**
 * Envelope a two-axle vehicle (equal axle weights, fixed spacing) against a
 * 3D influence line.
 */
export function envelopeFromInfluence3d(
  line: InfluenceLine3d,
  axleForceN: number,
  axleSpacingM = 4,
): InfluenceEnvelope3d {
  if (line.samples.length === 0) return { maxAbs: 0, criticalStation: 0 };
  let maxAbs = 0;
  let criticalStation = line.samples[0]!.station;
  for (const sample of line.samples) {
    const rear = interpolate3d(line, sample.station - axleSpacingM);
    const value = axleForceN * sample.value + axleForceN * rear;
    if (Math.abs(value) > maxAbs) {
      maxAbs = Math.abs(value);
      criticalStation = sample.station;
    }
  }
  return { maxAbs, criticalStation };
}

/** Per-member |M| envelope from midspan-moment influence lines under the current traffic vehicle. */
export function memberMomentEnvelopeFromInfluence3d(model: EditorModel3d): Map<number, number> {
  const weightkN = model.story?.kind === 'traffic' ? model.story.weightkN : 0;
  const axleForce = Math.max(0, weightkN) * 1000 / 2;
  const scenario = prepareInfluence3d(model);
  const envelope = new Map<number, number>();
  for (const memberId of model.deck ?? []) {
    const line = computeInfluenceLineAt3d(scenario, { kind: 'moment', memberId, at: 'mid', axis: 'mag' });
    envelope.set(memberId, envelopeFromInfluence3d(line, axleForce).maxAbs);
  }
  return envelope;
}

function interpolate3d(line: InfluenceLine3d, station: number): number {
  if (line.samples.length === 0) return 0;
  if (station <= line.samples[0]!.station) return 0;
  if (station >= line.samples[line.samples.length - 1]!.station) return 0;
  for (let index = 1; index < line.samples.length; index++) {
    const previous = line.samples[index - 1]!;
    const next = line.samples[index]!;
    if (station <= next.station) {
      const span = next.station - previous.station;
      if (span <= 0) return next.value;
      const t = (station - previous.station) / span;
      return previous.value * (1 - t) + next.value * t;
    }
  }
  return 0;
}

function readQuantity3d(
  mesh: AnalysisMesh3d,
  result: StaticResult3d,
  quantity: InfluenceQuantity3d,
  loadedElement: number,
): number {
  if (quantity.kind === 'reaction') {
    const reaction = result.reactions.get(quantity.nodeId);
    if (!reaction) return 0;
    return reaction[quantity.component];
  }
  if (quantity.kind === 'axial') {
    let governing = 0;
    let found = false;
    for (let index = 0; index < mesh.elements.length; index++) {
      if (mesh.elements[index]!.memberId !== quantity.memberId) continue;
      // Local Fx at end A is the tension-negative reaction; N = −Fx_a.
      const N = -result.elementForces[index * 12]!;
      if (!found || Math.abs(N) >= Math.abs(governing)) governing = N;
      found = true;
    }
    return found ? governing : 0;
  }
  return sectionMoment3d(mesh, result, quantity, loadedElement);
}

function sectionMoment3d(
  mesh: AnalysisMesh3d,
  result: StaticResult3d,
  quantity: Extract<InfluenceQuantity3d, { kind: 'moment' }>,
  loadedElement: number,
): number {
  const indices = mesh.elements.flatMap((element, index) => (element.memberId === quantity.memberId ? [index] : []));
  if (indices.length === 0) return 0;
  const axis = quantity.axis ?? 'mag';
  const pick = (index: number, end: 'a' | 'b'): number => {
    const base = index * 12 + (end === 'a' ? 0 : 6);
    const my = result.elementForces[base + 4]!;
    const mz = result.elementForces[base + 5]!;
    if (axis === 'y') return my;
    if (axis === 'z') return mz;
    return Math.hypot(my, mz);
  };
  if (quantity.at === 'a') return pick(indices[0]!, 'a');
  if (quantity.at === 'b') return pick(indices[indices.length - 1]!, 'b');
  if (indices.length === 1) {
    return 0.5 * (pick(indices[0]!, 'a') + pick(indices[0]!, 'b'));
  }
  const left = indices[0]!;
  const right = indices[1]!;
  // Prefer the end of the element that does NOT carry the in-span unit load —
  // its recovered end moment matches beam theory. Mirrors 2D §14 2D.
  if (loadedElement === left) return pick(right, 'a');
  if (loadedElement === right) return pick(left, 'b');
  return pick(left, 'b');
}
