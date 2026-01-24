/**
 * Newmark-β (γ=1/2, β=1/4) with Rayleigh damping; modal projection for the
 * explainer layer; DAF meter; resonance detection. M5.
 */
import { assembleK, assembleM } from './assemble';
import { expandFreeVector, factorLDLT, freeMatrix, freeVector, solveFactored, type Factor } from './solve';
import type { AnalysisMesh } from './types';

export interface NewmarkState {
  u: Float64Array;
  v: Float64Array;
  a: Float64Array;
  t: number;
  /** Optional Rayleigh coefficients retained across story steps. */
  damping?: RayleighParams;
  /** Cached M, C, and K̂ factor for a fixed mesh/time step. */
  system?: NewmarkSystem;
}

export interface RayleighParams {
  a: number; // mass-proportional
  b: number; // stiffness-proportional
}

/** Preassembled and factored fixed-system terms for repeated Newmark steps. */
export interface NewmarkSystem {
  ndof: number;
  dt: number;
  damping: RayleighParams;
  M: Float64Array;
  C: Float64Array;
  factor: Factor;
  a0: number;
  a1: number;
  a2: number;
  a3: number;
  a4: number;
  a5: number;
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

/** Assemble and factor K̂ once for a fixed Newmark run. */
export function prepareNewmarkSystem(
  mesh: AnalysisMesh,
  dt: number,
  damping: RayleighParams,
  mass: Float64Array = assembleM(mesh),
): NewmarkSystem {
  if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('Newmark time step must be finite and positive.');
  if (mass.length !== mesh.ndof * mesh.ndof) throw new Error('Newmark mass matrix size does not match the mesh.');
  const K = assembleK(mesh);
  const M = mass;
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
  const result = factorLDLT(freeMatrix(Khat, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  if (!result.ok) throw new Error(`Dynamic effective stiffness is singular at free DOF ${result.mechanism.freeDofIndex}.`);
  return { ndof: mesh.ndof, dt, damping: { ...damping }, M, C, factor: result.factor, a0, a1, a2, a3, a4, a5 };
}

/**
 * One average-acceleration Newmark step on the mesh free-DOF partition.
 * K̂ = K + a0M + a1C, with the matching effective load.
 * Pass `mass` to rebuild K̂ when M changes (moving vehicle).
 */
export function newmarkStep(
  mesh: AnalysisMesh,
  state: NewmarkState,
  loadAt: (t: number) => Float64Array,
  dt: number,
  damping: RayleighParams = state.damping ?? { a: 0, b: 0 },
  mass?: Float64Array,
): NewmarkState {
  if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('Newmark time step must be finite and positive.');
  validateState(mesh, state);
  const system = mass
    ? prepareNewmarkSystem(mesh, dt, damping, mass)
    : usableSystem(state.system, mesh, dt, damping)
      ? state.system
      : prepareNewmarkSystem(mesh, dt, damping);

  const nextTime = state.t + dt;
  const effectiveLoad = new Float64Array(loadAt(nextTime));
  if (effectiveLoad.length !== mesh.ndof) throw new Error('Dynamic load vector length does not match the mesh.');
  const massState = combination3(state.u, state.v, state.a, system.a0, system.a2, system.a3);
  const dampingState = combination3(state.u, state.v, state.a, system.a1, system.a4, system.a5);
  addScaledVector(effectiveLoad, multiplyMatrixVector(system.M, mesh.ndof, massState), 1);
  addScaledVector(effectiveLoad, multiplyMatrixVector(system.C, mesh.ndof, dampingState), 1);
  const u = expandFreeVector(mesh.ndof, mesh.freeDofs, solveFactored(system.factor, freeVector(effectiveLoad, mesh.freeDofs)));
  const a = new Float64Array(mesh.ndof);
  const v = new Float64Array(mesh.ndof);
  for (let index = 0; index < mesh.ndof; index++) {
    a[index] = system.a0 * (u[index]! - state.u[index]!) - system.a2 * state.v[index]! - system.a3 * state.a[index]!;
    v[index] = state.v[index]! + dt * (0.5 * state.a[index]! + 0.5 * a[index]!);
  }
  // Varying-mass steps must not reuse a stale K̂ factor.
  return { u, v, a, t: nextTime, damping: { ...damping }, system: mass ? undefined : system };
}

/** Exact SDOF DAF for a harmonic force, used by the honest live meter. */
export function dynamicAmplificationRatio(forceOmega: number, naturalOmega: number, zeta: number): number {
  if (!(forceOmega >= 0) || !(naturalOmega > 0) || !(zeta >= 0)) throw new Error('DAF inputs must be non-negative with a positive natural frequency.');
  const ratio = forceOmega / naturalOmega;
  return 1 / Math.sqrt((1 - ratio * ratio) ** 2 + (2 * zeta * ratio) ** 2);
}

/**
 * Influence vector ι with unity on global-x translational DOFs (base excitation).
 */
export function influenceVectorX(mesh: AnalysisMesh): Float64Array {
  const iota = new Float64Array(mesh.ndof);
  for (let node = 0; mesh.ndof > node * 3; node++) iota[3 * node] = 1;
  return iota;
}

/**
 * Effective nodal load from horizontal base acceleration: −M · ι · ü_g.
 */
export function baseExcitationLoad(mass: Float64Array, ndof: number, iota: Float64Array, ugDdot: number): Float64Array {
  if (mass.length !== ndof * ndof || iota.length !== ndof) {
    throw new Error('Base-excitation load requires matching mass, ι, and ndof.');
  }
  const load = new Float64Array(ndof);
  // F = −üg · (M ι)
  for (let row = 0; row < ndof; row++) {
    let Mi = 0;
    for (let column = 0; column < ndof; column++) Mi += mass[row * ndof + column]! * iota[column]!;
    load[row] = -ugDdot * Mi;
  }
  return load;
}

function validateState(mesh: AnalysisMesh, state: NewmarkState): void {
  if (state.u.length !== mesh.ndof || state.v.length !== mesh.ndof || state.a.length !== mesh.ndof) {
    throw new Error('Newmark state vectors must match the mesh DOF count.');
  }
  if (!Number.isFinite(state.t)) throw new Error('Newmark state time must be finite.');
}

function usableSystem(system: NewmarkSystem | undefined, mesh: AnalysisMesh, dt: number, damping: RayleighParams): system is NewmarkSystem {
  return system !== undefined
    && system.ndof === mesh.ndof
    && system.dt === dt
    && system.damping.a === damping.a
    && system.damping.b === damping.b;
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
