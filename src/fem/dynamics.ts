/**
 * Newmark-β (γ=1/2, β=1/4) with Rayleigh damping; modal projection for the
 * explainer layer; DAF meter; resonance detection. M5.
 */
import { assembleK, assembleM } from './assemble';
import { expandFreeVector, factorLDLT, freeMatrix, freeVector, solveFactored } from './solve';
import type { AnalysisMesh } from './types';

export interface NewmarkState {
  u: Float64Array;
  v: Float64Array;
  a: Float64Array;
  t: number;
  /** Optional Rayleigh coefficients retained across story steps. */
  damping?: RayleighParams;
}

export interface RayleighParams {
  a: number; // mass-proportional
  b: number; // stiffness-proportional
}

/** Fit a and b from a target damping ratio at two circular frequencies. Gate G9. */
export function rayleighFit(zeta: number, w1: number, w2: number): RayleighParams {
  if (!(zeta >= 0) || !Number.isFinite(zeta)) throw new Error('Rayleigh damping ratio must be finite and non-negative.');
  if (!(w1 > 0) || !(w2 > 0) || !Number.isFinite(w1) || !Number.isFinite(w2)) {
    throw new Error('Rayleigh fit needs two finite positive circular frequencies.');
  }
  return {
    a: (2 * zeta * w1 * w2) / (w1 + w2),
    b: (2 * zeta) / (w1 + w2),
  };
}

/** ζ(ω) = ½(a/ω + bω) for a Rayleigh-damped mode. */
export function rayleighDampingRatio(params: RayleighParams, omega: number): number {
  if (!(omega > 0) || !Number.isFinite(omega)) throw new Error('Modal circular frequency must be finite and positive.');
  return 0.5 * (params.a / omega + params.b * omega);
}

/**
 * One average-acceleration Newmark step on the mesh free-DOF partition.
 * K̂ = K + a0M + a1C, with the matching effective load.
 */
export function newmarkStep(
  mesh: AnalysisMesh,
  state: NewmarkState,
  loadAt: (t: number) => Float64Array,
  dt: number,
  damping: RayleighParams = state.damping ?? { a: 0, b: 0 },
): NewmarkState {
  if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('Newmark time step must be finite and positive.');
  validateState(mesh, state);
  const K = assembleK(mesh);
  const M = assembleM(mesh);
  const C = linearCombination(M, K, damping.a, damping.b);
  const beta = 1 / 4;
  const gamma = 1 / 2;
  const a0 = 1 / (beta * dt * dt);
  const a1 = gamma / (beta * dt);
  const a2 = 1 / (beta * dt);
  const a3 = 1 / (2 * beta) - 1;
  const a4 = gamma / beta - 1;
  const a5 = dt * (gamma / (2 * beta) - 1);

  const Khat = linearCombination(K, M, 1, a0);
  addScaled(Khat, C, a1);
  const factor = factorLDLT(freeMatrix(Khat, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  if (!factor.ok) throw new Error(`Dynamic effective stiffness is singular at free DOF ${factor.mechanism.freeDofIndex}.`);

  const nextTime = state.t + dt;
  const effectiveLoad = new Float64Array(loadAt(nextTime));
  if (effectiveLoad.length !== mesh.ndof) throw new Error('Dynamic load vector length does not match the mesh.');
  const massState = combination3(state.u, state.v, state.a, a0, a2, a3);
  const dampingState = combination3(state.u, state.v, state.a, a1, a4, a5);
  addScaledVector(effectiveLoad, multiplyMatrixVector(M, mesh.ndof, massState), 1);
  addScaledVector(effectiveLoad, multiplyMatrixVector(C, mesh.ndof, dampingState), 1);
  const u = expandFreeVector(mesh.ndof, mesh.freeDofs, solveFactored(factor.factor, freeVector(effectiveLoad, mesh.freeDofs)));
  const a = new Float64Array(mesh.ndof);
  const v = new Float64Array(mesh.ndof);
  for (let index = 0; index < mesh.ndof; index++) {
    a[index] = a0 * (u[index]! - state.u[index]!) - a2 * state.v[index]! - a3 * state.a[index]!;
    v[index] = state.v[index]! + dt * ((1 - gamma) * state.a[index]! + gamma * a[index]!);
  }
  return { u, v, a, t: nextTime, damping: { ...damping } };
}

/** Exact SDOF DAF for a harmonic force, used by the honest live meter. */
export function dynamicAmplificationRatio(forceOmega: number, naturalOmega: number, zeta: number): number {
  if (!(forceOmega >= 0) || !(naturalOmega > 0) || !(zeta >= 0)) throw new Error('DAF inputs must be non-negative with a positive natural frequency.');
  const ratio = forceOmega / naturalOmega;
  return 1 / Math.sqrt((1 - ratio * ratio) ** 2 + (2 * zeta * ratio) ** 2);
}

function validateState(mesh: AnalysisMesh, state: NewmarkState): void {
  if (state.u.length !== mesh.ndof || state.v.length !== mesh.ndof || state.a.length !== mesh.ndof) {
    throw new Error('Newmark state vectors must match the mesh DOF count.');
  }
  if (!Number.isFinite(state.t)) throw new Error('Newmark state time must be finite.');
}

function linearCombination(first: Float64Array, second: Float64Array, firstScale: number, secondScale: number): Float64Array {
  if (first.length !== second.length) throw new Error('Matrix dimensions do not match.');
  const out = new Float64Array(first.length);
  for (let index = 0; index < out.length; index++) out[index] = firstScale * first[index]! + secondScale * second[index]!;
  return out;
}

function addScaled(target: Float64Array, source: Float64Array, scale: number): void {
  for (let index = 0; index < target.length; index++) target[index] = target[index]! + scale * source[index]!;
}

function combination3(
  first: Float64Array,
  second: Float64Array,
  third: Float64Array,
  firstScale: number,
  secondScale: number,
  thirdScale: number,
): Float64Array {
  const out = new Float64Array(first.length);
  for (let index = 0; index < out.length; index++) out[index] = firstScale * first[index]! + secondScale * second[index]! + thirdScale * third[index]!;
  return out;
}

function multiplyMatrixVector(matrix: Float64Array, n: number, vector: Float64Array): Float64Array {
  const out = new Float64Array(n);
  for (let row = 0; row < n; row++) {
    let value = 0;
    for (let column = 0; column < n; column++) value += matrix[row * n + column]! * vector[column]!;
    out[row] = value;
  }
  return out;
}

function addScaledVector(target: Float64Array, source: Float64Array, scale: number): void {
  for (let index = 0; index < target.length; index++) target[index] = target[index]! + scale * source[index]!;
}
