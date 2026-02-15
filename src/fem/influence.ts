/**
 * Influence lines: unit-load deck sweep for reaction, axial, and section-moment
 * response quantities, plus two-axle envelope evaluation from the line.
 * docs/FEM-SPEC.md §14 2D.
 */
import { assembleLoadCase, type LoadAssembly } from './assemble';
import {
  buildDeckRoute,
  deckLength,
  editorNodeIndex,
  mapDeckStation,
  type DeckSegment,
} from './deck';
import { buildMesh } from './mesh';
import { prepareStaticSystem, solveStatic, type StaticSystem } from './statics';
import type { AnalysisMesh, AnalysisOptions, EditorModel, StaticResult } from './types';

/** Response quantity whose influence line is traced by a unit downward deck load. docs/FEM-SPEC.md §14 2D. */
export type InfluenceQuantity =
  | { kind: 'reaction'; nodeId: number; component: 'fx' | 'fy' | 'm' }
  | { kind: 'axial'; memberId: number }
  | { kind: 'moment'; memberId: number; at: 'a' | 'b' | 'mid' };

interface InfluenceSample {
  station: number;
  x: number;
  y: number;
  value: number;
}

export interface InfluenceLine {
  quantity: InfluenceQuantity;
  length: number;
  samples: InfluenceSample[];
  peak: { station: number; value: number };
}

interface InfluenceScenario {
  model: EditorModel;
  mesh: AnalysisMesh;
  route: DeckSegment[];
  length: number;
  nodeIndex: Map<number, number>;
  system: StaticSystem;
}

export interface InfluenceEnvelope {
  /** Maximum absolute response under the two-axle vehicle along the deck. */
  maxAbs: number;
  /** Front-axle station (m) that attains maxAbs. */
  criticalStation: number;
}

/** Factor the deck once; subsequent unit-load stations are back-substitutions. docs/FEM-SPEC.md §14 2D. */
function prepareInfluence(model: EditorModel, options: AnalysisOptions = {}): InfluenceScenario {
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

/**
 * Sweep a unit global-downward load along the deck and record the chosen response.
 * Default step is L/40 (dense enough for the piecewise-linear SS-beam gate). docs/FEM-SPEC.md §14 2D.
 */
export function computeInfluenceLine(
  model: EditorModel,
  quantity: InfluenceQuantity,
  options: AnalysisOptions & { step?: number } = {},
): InfluenceLine {
  const { step, ...analysisOptions } = options;
  return computeInfluenceLineAt(prepareInfluence(model, analysisOptions), quantity, step);
}

/** Re-use a prepared deck factorization for an influence sweep. docs/FEM-SPEC.md §14 2D. */
function computeInfluenceLineAt(
  scenario: InfluenceScenario,
  quantity: InfluenceQuantity,
  stepMeters?: number,
): InfluenceLine {
  const step = stepMeters ?? Math.max(scenario.length / 40, 1e-6);
  const samples: InfluenceSample[] = [];
  for (let station = 0; station <= scenario.length + 1e-12; station += step) {
    const clamped = Math.min(station, scenario.length);
    const sample = sampleInfluenceAt(scenario, clamped, quantity);
    if (sample) samples.push(sample);
    if (clamped === scenario.length) break;
  }
  if (samples.length === 0 || samples[samples.length - 1]!.station < scenario.length - 1e-12) {
    const end = sampleInfluenceAt(scenario, scenario.length, quantity);
    if (end) samples.push(end);
  }
  let peak = samples[0] ?? { station: 0, value: 0 };
  for (const sample of samples) {
    if (Math.abs(sample.value) > Math.abs(peak.value)) peak = sample;
  }
  return {
    quantity,
    length: scenario.length,
    samples,
    peak: { station: peak.station, value: peak.value },
  };
}

/** Unit-load response at one deck station. docs/FEM-SPEC.md §14 2D. */
function sampleInfluenceAt(
  scenario: InfluenceScenario,
  station: number,
  quantity: InfluenceQuantity,
): InfluenceSample | undefined {
  const hits = mapDeckStation(scenario.model, scenario.mesh, scenario.route, station);
  if (hits.length === 0) return undefined;
  const hit = hits[0]!;
  const loads = assembleLoadCase(scenario.mesh, {
    gravity: false,
    points: [],
    inElement: [{ element: hit.element, xi: hit.xi, p: 1 }],
  });
  const analysis = solveStatic(scenario.mesh, loads, scenario.system);
  if (analysis.kind !== 'stable') return undefined;
  return {
    station: hit.station,
    x: hit.x,
    y: hit.y,
    value: readQuantity(scenario.mesh, analysis.result, loads, quantity, hit.element),
  };
}

/**
 * Envelope a two-axle vehicle (equal axle weights, fixed spacing) against an
 * influence line — the analytic twin of the traffic moment-envelope sweep. docs/FEM-SPEC.md §14 2D.
 */
export function envelopeFromInfluence(
  line: InfluenceLine,
  axleForceN: number,
  axleSpacingM = 4,
): InfluenceEnvelope {
  if (line.samples.length === 0) return { maxAbs: 0, criticalStation: 0 };
  let maxAbs = 0;
  let criticalStation = line.samples[0]!.station;
  for (const sample of line.samples) {
    const rear = interpolateInfluence(line, sample.station - axleSpacingM);
    const value = axleForceN * sample.value + axleForceN * rear;
    if (Math.abs(value) > maxAbs) {
      maxAbs = Math.abs(value);
      criticalStation = sample.station;
    }
  }
  return { maxAbs, criticalStation };
}

/**
 * Per-member |M| envelope implied by a midspan-or-end moment influence line under
 * the current traffic vehicle. docs/FEM-SPEC.md §6.3 / §14 2D.
 */
export function memberMomentEnvelopeFromInfluence(
  model: EditorModel,
  options: AnalysisOptions = {},
): Map<number, number> {
  const weightkN = model.story.kind === 'traffic' ? model.story.weightkN : 0;
  const axleForce = (Math.max(0, weightkN) * 1000) / 2;
  const scenario = prepareInfluence(model, options);
  const envelope = new Map<number, number>();
  for (const memberId of model.deck) {
    const line = computeInfluenceLineAt(scenario, { kind: 'moment', memberId, at: 'mid' });
    envelope.set(memberId, envelopeFromInfluence(line, axleForce).maxAbs);
  }
  return envelope;
}

function interpolateInfluence(line: InfluenceLine, station: number): number {
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

function readQuantity(
  mesh: AnalysisMesh,
  result: StaticResult,
  loads: LoadAssembly,
  quantity: InfluenceQuantity,
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
      const N = result.elementForces[index * 5]!;
      if (!found || Math.abs(N) >= Math.abs(governing)) governing = N;
      found = true;
    }
    return found ? governing : 0;
  }
  return sectionMoment(mesh, result, loads, quantity.memberId, quantity.at, loadedElement);
}

/**
 * Section moment with sagging-positive sign on a left-to-right chord.
 * At a shared mid-node, prefer the adjacent element that does not carry the
 * in-span unit load — its recovered end moment matches beam theory. docs/FEM-SPEC.md §14 2D.
 */
function sectionMoment(
  mesh: AnalysisMesh,
  result: StaticResult,
  loads: LoadAssembly,
  memberId: number,
  at: 'a' | 'b' | 'mid',
  loadedElement: number,
): number {
  const indices = mesh.elements.flatMap((element, index) =>
    element.memberId === memberId ? [index] : [],
  );
  if (indices.length === 0) return 0;
  if (at === 'a') {
    const index = indices[0]!;
    return endMoment(mesh, result, index, 'a');
  }
  if (at === 'b') {
    const index = indices[indices.length - 1]!;
    return endMoment(mesh, result, index, 'b');
  }
  if (indices.length === 1) {
    const index = indices[0]!;
    const Ma = -result.elementForces[index * 5 + 2]!;
    const Mb = result.elementForces[index * 5 + 4]!;
    return 0.5 * (Ma + Mb);
  }
  // Two (or more) subdivisions: mid-node is the joint between the first two
  // deck-ordered analysis elements of this member.
  const left = indices[0]!;
  const right = indices[1]!;
  const leftHasLoad = elementHasFixedEnd(loads, left);
  const rightHasLoad = elementHasFixedEnd(loads, right);
  if (leftHasLoad && !rightHasLoad) return endMoment(mesh, result, right, 'a');
  if (rightHasLoad && !leftHasLoad) return endMoment(mesh, result, left, 'b');
  if (loadedElement === left) return -endMoment(mesh, result, right, 'a');
  if (loadedElement === right) return endMoment(mesh, result, left, 'b');
  return endMoment(mesh, result, left, 'b');
}

function endMoment(
  mesh: AnalysisMesh,
  result: StaticResult,
  elementIndex: number,
  end: 'a' | 'b',
): number {
  const element = mesh.elements[elementIndex]!;
  const raw =
    end === 'a'
      ? -result.elementForces[elementIndex * 5 + 2]!
      : result.elementForces[elementIndex * 5 + 4]!;
  // Deck members drawn right-to-left reverse the local sagging-positive sense.
  return element.cos >= 0 ? raw : -raw;
}

function elementHasFixedEnd(loads: LoadAssembly, elementIndex: number): boolean {
  const offset = elementIndex * 6;
  for (let i = 0; i < 6; i++) {
    if (Math.abs(loads.elementFixedEnd[offset + i]!) > 1e-15) return true;
  }
  return false;
}
