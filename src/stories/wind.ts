/**
 * Deterministic wind-story controller. It builds horizontal tributary loads
 * and advances the verified Newmark kernel at four 1/240 s substeps/frame.
 */
import { assembleM } from '../fem/assemble';
import { newmarkStep, prepareNewmarkSystem, rayleighFit, type NewmarkState } from '../fem/dynamics';
import { buildMesh } from '../fem/mesh';
import { analyzeStaticModel, utilizationAtDisplacement, type StaticAnalysis } from '../fem/statics';
import type { AnalysisMesh, EditorModel, EigenResult } from '../fem/types';

export interface WindScenario {
  mesh: AnalysisMesh;
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

/** Prepare a repeatable uniform wind field, including its static starting state. */
export function prepareWind(model: EditorModel): WindScenario | undefined {
  if (model.story.kind !== 'wind') return undefined;
  try {
    const mesh = buildMesh(model);
    const baseAnalysis = analyzeStaticModel(model);
    const baseLoad = baseAnalysis.kind === 'stable' ? new Float64Array(baseAnalysis.loads.F) : new Float64Array(mesh.ndof);
    const baseFixedEnd = baseAnalysis.kind === 'stable' ? new Float64Array(baseAnalysis.loads.elementFixedEnd) : new Float64Array(mesh.elements.length * 6);
    return { mesh, baseAnalysis, baseLoad, baseFixedEnd, dt: 1 / 240, mass: assembleM(mesh), model: model.story, seed: model.seed };
  } catch {
    return undefined;
  }
}

/**
 * Equivalent nodal horizontal wind forces q·L_vertical/2 at each element end.
 * q is a kN/m line load over the member's projected vertical extent.
 */
export function windLoadAt(scenario: WindScenario, time: number): Float64Array {
  const load = new Float64Array(scenario.baseLoad);
  const q = scenario.model.amplitudekNm * 1000 * windMultiplier(scenario.model, scenario.seed, time);
  for (const element of scenario.mesh.elements) {
    const tributary = Math.abs(element.sin) * element.L;
    const force = q * tributary / 2;
    const aDof = 3 * element.na;
    const bDof = 3 * element.nb;
    load[aDof] = load[aDof]! + force;
    load[bDof] = load[bDof]! + force;
  }
  return load;
}

/** Build a zero-velocity dynamic state around the already-solved gravity/point-load equilibrium. */
export function initialWindState(scenario: WindScenario, modal?: EigenResult): NewmarkState | undefined {
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

/** Advance Newmark by a whole display frame (four fixed substeps). */
export function stepWind(scenario: WindScenario, state: NewmarkState, substeps = 4): NewmarkState {
  let next = state;
  for (let index = 0; index < substeps; index++) next = newmarkStep(scenario.mesh, next, (time) => windLoadAt(scenario, time), scenario.dt);
  return next;
}

/** q_i = φ_iᵀ M u for the mass-normalized modal explainer bars. */
export function modalCoordinates(mesh: AnalysisMesh, modal: EigenResult, u: Float64Array, mass = assembleM(mesh)): Float64Array {
  const count = modal.values.length;
  const output = new Float64Array(count);
  if (modal.vectors.length !== mesh.ndof * count || u.length !== mesh.ndof) return output;
  const Mu = multiply(mass, mesh.ndof, u);
  for (let mode = 0; mode < count; mode++) {
    let value = 0;
    for (let dof = 0; dof < mesh.ndof; dof++) value += modal.vectors[dof * count + mode]! * Mu[dof]!;
    output[mode] = value;
  }
  return output;
}

/** Dynamic combined-stress utilization with gravity fixed-end recovery retained. */
export function windUtilization(scenario: WindScenario, u: Float64Array): Map<number, number> {
  return utilizationAtDisplacement(scenario.mesh, u, scenario.baseFixedEnd);
}

/** The documented three-part resonance threshold. */
export function detectResonance(
  forcingHz: number,
  modal: EigenResult | undefined,
  zeta: number,
  recentCoordinates: readonly number[],
): number | undefined {
  if (!modal || zeta >= 0.05 || recentCoordinates.length < 2) return undefined;
  const first = recentCoordinates[0] ?? 0;
  const latest = recentCoordinates.at(-1) ?? 0;
  if (Math.abs(latest) <= Math.max(1e-12, Math.abs(first) * 1.5)) return undefined;
  for (let mode = 0; mode < modal.values.length; mode++) {
    const frequency = modal.values[mode]! / (Math.PI * 2);
    if (Math.abs(forcingHz - frequency) / frequency <= 0.1) return mode;
  }
  return undefined;
}

function windMultiplier(story: WindScenario['model'], seed: number, time: number): number {
  if (story.pattern === 'steady') return 1;
  if (story.pattern === 'sine') return Math.sin(Math.PI * 2 * story.freqHz * time);
  let value = 0.35;
  for (let index = 0; index < 5; index++) {
    const random = seeded(seed + index * 977);
    const frequency = 0.1 + random() * 1.9;
    const phase = random() * Math.PI * 2;
    value += 0.2 * Math.sin(Math.PI * 2 * frequency * time + phase);
  }
  return value;
}

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function multiply(matrix: Float64Array, size: number, vector: Float64Array): Float64Array {
  const out = new Float64Array(size);
  for (let row = 0; row < size; row++) {
    let value = 0;
    for (let column = 0; column < size; column++) value += matrix[row * size + column]! * vector[column]!;
    out[row] = value;
  }
  return out;
}
