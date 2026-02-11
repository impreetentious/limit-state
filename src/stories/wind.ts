/**
 * Deterministic wind-story controller. It builds horizontal tributary loads
 * and advances the verified Newmark kernel at four 1/240 s substeps/frame.
 * docs/FEM-SPEC.md §4.6 and §6.3.
 */
import { assembleM } from '../fem/assemble';
import { newmarkStep, prepareNewmarkSystem, rayleighFit, type NewmarkState } from '../fem/dynamics';
import { buildMesh } from '../fem/mesh';
import { mulberry32 } from '../fem/rng';
import {
  analyzeStaticModel,
  prepareStaticSystem,
  solveStatic,
  utilizationAtDisplacement,
  type StaticAnalysis,
  type StaticSystem,
} from '../fem/statics';
import type { AnalysisMesh, AnalysisOptions, EditorModel, EigenResult } from '../fem/types';

export interface WindScenario {
  mesh: AnalysisMesh;
  /** Cached factorization for the unit-wind reference response. */
  staticSystem: StaticSystem;
  baseAnalysis: StaticAnalysis;
  /** Retained gravity/point-load equilibrium applied throughout the transient. */
  baseLoad: Float64Array;
  /** Retained distributed-load fixed-end forces for dynamic stress recovery. */
  baseFixedEnd: Float64Array;
  dt: number;
  mass: Float64Array;
  model: Extract<EditorModel['story'], { kind: 'wind' }>;
  seed: number;
}

/** Prepare a repeatable uniform wind field, including its static starting state. docs/FEM-SPEC.md §6.3. */
export function prepareWind(
  model: EditorModel,
  options: AnalysisOptions = {},
): WindScenario | undefined {
  if (model.story.kind !== 'wind') return undefined;
  try {
    const mesh = buildMesh(model, options);
    const baseAnalysis = analyzeStaticModel(model, options);
    const baseLoad =
      baseAnalysis.kind === 'stable'
        ? new Float64Array(baseAnalysis.loads.F)
        : new Float64Array(mesh.ndof);
    const baseFixedEnd =
      baseAnalysis.kind === 'stable'
        ? new Float64Array(baseAnalysis.loads.elementFixedEnd)
        : new Float64Array(mesh.elements.length * 6);
    return {
      mesh,
      staticSystem: prepareStaticSystem(mesh),
      baseAnalysis,
      baseLoad,
      baseFixedEnd,
      dt: 1 / 240,
      mass: assembleM(mesh),
      model: model.story,
      seed: model.seed,
    };
  } catch {
    return undefined;
  }
}

/**
 * Equivalent nodal wind forces q·L_projected/2 at each element end.
 * This in-plane model treats wind as uniform member-normal pressure: vertical
 * faces receive horizontal force and horizontal faces receive vertical force.
 * docs/FEM-SPEC.md §6.3.
 */
export function windLoadAt(scenario: WindScenario, time: number): Float64Array {
  const load = new Float64Array(scenario.baseLoad);
  const increment = windIncrementAt(scenario, time);
  for (let dof = 0; dof < load.length; dof++) load[dof] = load[dof]! + increment[dof]!;
  return load;
}

/** Unit-amplitude wind load for an honest measured dynamic-amplification reference. docs/FEM-SPEC.md §4.6 and §6.3. */
export function windReferenceCoordinates(scenario: WindScenario, modal: EigenResult): Float64Array {
  const loads = {
    F: windIncrementForMultiplier(scenario, 1),
    elementFixedEnd: new Float64Array(scenario.mesh.elements.length * 6),
    elementTransverseUdl: new Float64Array(scenario.mesh.elements.length),
  };
  const analysis = solveStatic(scenario.mesh, loads, scenario.staticSystem);
  return analysis.kind === 'stable'
    ? modalCoordinates(scenario.mesh, modal, analysis.result.u, scenario.mass)
    : new Float64Array(modal.values.length);
}

/** Dynamic/static ratio for the modal coordinate that currently dominates the response. docs/FEM-SPEC.md §4.6. */
export function measuredDaf(
  coordinates: Float64Array,
  referenceCoordinates: Float64Array,
): { mode: number; ratio: number } | undefined {
  let mode = -1;
  let largest = 0;
  for (let index = 0; index < Math.min(coordinates.length, referenceCoordinates.length); index++) {
    const reference = Math.abs(referenceCoordinates[index]!);
    const amplitude = Math.abs(coordinates[index]!);
    if (reference > 1e-12 && amplitude > largest) {
      largest = amplitude;
      mode = index;
    }
  }
  return mode >= 0 ? { mode, ratio: largest / Math.abs(referenceCoordinates[mode]!) } : undefined;
}

function windIncrementAt(scenario: WindScenario, time: number): Float64Array {
  return windIncrementForMultiplier(scenario, windMultiplier(scenario.model, scenario.seed, time));
}

function windIncrementForMultiplier(scenario: WindScenario, multiplier: number): Float64Array {
  const load = new Float64Array(scenario.mesh.ndof);
  const q = scenario.model.amplitudekNm * 1000 * multiplier;
  for (const element of scenario.mesh.elements) {
    // A horizontal member still has an exposed vertical depth (2c); without
    // it, a slender deck would receive no wind excitation in a 2D section.
    const tributary = Math.max(Math.abs(element.sin) * element.L, 2 * element.c);
    const force = (q * tributary) / 2;
    const aDof = 3 * element.na;
    const bDof = 3 * element.nb;
    const normalX = element.sin;
    const normalY = -element.cos;
    load[aDof] = load[aDof]! + force * normalX;
    load[aDof + 1] = load[aDof + 1]! + force * normalY;
    load[bDof] = load[bDof]! + force * normalX;
    load[bDof + 1] = load[bDof + 1]! + force * normalY;
  }
  return load;
}

/** Build a zero-velocity dynamic state around the already-solved gravity/point-load equilibrium. docs/FEM-SPEC.md §4.6. */
export function initialWindState(
  scenario: WindScenario,
  modal?: EigenResult,
): NewmarkState | undefined {
  if (scenario.baseAnalysis.kind !== 'stable') return undefined;
  const omega1 = modal?.values[0];
  const omega2 = modal?.values[1] ?? (omega1 ? omega1 * 3 : undefined);
  if (!(omega1 && omega2)) return undefined;
  const damping = rayleighFit(scenario.model.zeta, omega1, omega2);
  return {
    u: new Float64Array(scenario.baseAnalysis.result.u),
    v: new Float64Array(scenario.mesh.ndof),
    a: new Float64Array(scenario.mesh.ndof),
    t: 0,
    damping,
    system: prepareNewmarkSystem(scenario.mesh, scenario.dt, damping),
  };
}

/** Advance Newmark by a whole display frame (four fixed substeps). docs/FEM-SPEC.md §4.6. */
export function stepWind(scenario: WindScenario, state: NewmarkState, substeps = 4): NewmarkState {
  let next = state;
  for (let index = 0; index < substeps; index++)
    next = newmarkStep(scenario.mesh, next, (time) => windLoadAt(scenario, time), scenario.dt);
  return next;
}

/** q_i = φ_iᵀ M u for the mass-normalized modal explainer bars. docs/FEM-SPEC.md §4.6. */
export function modalCoordinates(
  mesh: AnalysisMesh,
  modal: EigenResult,
  u: Float64Array,
  mass = assembleM(mesh),
): Float64Array {
  const count = modal.values.length;
  const output = new Float64Array(count);
  if (modal.vectors.length !== mesh.ndof * count || u.length !== mesh.ndof) return output;
  const Mu = multiply(mass, mesh.ndof, u);
  for (let mode = 0; mode < count; mode++) {
    let value = 0;
    for (let dof = 0; dof < mesh.ndof; dof++)
      value += modal.vectors[dof * count + mode]! * Mu[dof]!;
    output[mode] = value;
  }
  return output;
}

/** Dynamic combined-stress utilization with gravity fixed-end recovery retained. docs/FEM-SPEC.md §4.1 and §4.7. */
export function windUtilization(scenario: WindScenario, u: Float64Array): Map<number, number> {
  return utilizationAtDisplacement(scenario.mesh, u, scenario.baseFixedEnd);
}

/** The documented three-part resonance threshold. docs/FEM-SPEC.md §4.6. */
export function detectResonance(
  forcingHz: number,
  modal: EigenResult | undefined,
  zeta: number,
  recentCoordinates: readonly number[],
  samplesPerCycle = 1,
): number | undefined {
  const samples = Math.max(1, Math.ceil(samplesPerCycle));
  const required = samples * 5;
  if (!modal || zeta >= 0.05 || recentCoordinates.length < required) return undefined;
  const window = recentCoordinates.slice(-required);
  const first = peakMagnitude(window.slice(0, samples));
  const latest = peakMagnitude(window.slice(-samples));
  if (latest <= Math.max(1e-12, first * 1.5)) return undefined;
  for (let mode = 0; mode < modal.values.length; mode++) {
    const frequency = modal.values[mode]! / (Math.PI * 2);
    if (Math.abs(forcingHz - frequency) / frequency <= 0.1) return mode;
  }
  return undefined;
}

function peakMagnitude(values: readonly number[]): number {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  return peak;
}

function windMultiplier(story: WindScenario['model'], seed: number, time: number): number {
  if (story.pattern === 'steady') return 1;
  if (story.pattern === 'sine') return Math.sin(Math.PI * 2 * story.freqHz * time);
  let value = 0.35;
  for (let index = 0; index < 5; index++) {
    const random = mulberry32(seed + index * 977);
    const frequency = 0.1 + random() * 1.9;
    const phase = random() * Math.PI * 2;
    value += 0.2 * Math.sin(Math.PI * 2 * frequency * time + phase);
  }
  return value;
}

function multiply(matrix: Float64Array, size: number, vector: Float64Array): Float64Array {
  const out = new Float64Array(size);
  for (let row = 0; row < size; row++) {
    let value = 0;
    for (let column = 0; column < size; column++)
      value += matrix[row * size + column]! * vector[column]!;
    out[row] = value;
  }
  return out;
}
