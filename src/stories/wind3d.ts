/**
 * 3D wind story — horizontal pressure with a direction dial.
 * Wind gains a direction dial.
 *
 * Reuses the dimension-agnostic Newmark integrator (`prepareNewmarkSystemAssembled`
 * / `newmarkStepAssembled`). Tributary length = L · |e × windDir| with a 2c
 * fallback for members nearly parallel to the wind (mirrors the 2D §6.3 note).
 */
import {
  newmarkStepAssembled,
  prepareNewmarkSystemAssembled,
  rayleighFit,
  type NewmarkState,
} from '../fem/dynamics';
import {
  assembleK3d,
  assembleM3d,
  analyzeStaticModel3d,
  type AnalysisMesh3d,
  type EditorModel3d,
  type StaticAnalysis3d,
  type StorySpec3d,
} from '../fem/space';
import { matvecSkyline, skylineToDense } from '../fem/skyline';
import type { EigenResult } from '../fem/types';

export interface WindScenario3d {
  mesh: AnalysisMesh3d;
  baseAnalysis: StaticAnalysis3d;
  baseLoad: Float64Array;
  dt: number;
  mass: Float64Array;
  K: Float64Array;
  model: Extract<StorySpec3d, { kind: 'wind' }>;
  seed: number;
}

export function prepareWind3d(model: EditorModel3d): WindScenario3d | undefined {
  if (model.story?.kind !== 'wind') return undefined;
  try {
    const baseAnalysis = analyzeStaticModel3d(model);
    if (baseAnalysis.kind !== 'stable') return undefined;
    const { mesh } = baseAnalysis;
    const Ksky = assembleK3d(mesh);
    const mass = assembleM3d(mesh);
    // Recover the static load that produced the base equilibrium by K·u
    // (point loads + any gravity already baked into the solved state).
    const baseLoad = matvecSkyline(Ksky, baseAnalysis.result.u);
    return {
      mesh,
      baseAnalysis,
      baseLoad,
      dt: 1 / 240,
      mass,
      K: skylineToDense(Ksky),
      model: model.story,
      seed: model.seed,
    };
  } catch {
    return undefined;
  }
}

/** Horizontal wind unit vector from directionDeg (0 = +X, 90 = +Y). */
export function windDirectionUnit(directionDeg: number): { x: number; y: number; z: number } {
  const rad = (directionDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad), z: 0 };
}

export function windLoadAt3d(scenario: WindScenario3d, time: number): Float64Array {
  const load = new Float64Array(scenario.baseLoad);
  const increment = windIncrementForMultiplier3d(
    scenario,
    windMultiplier(scenario.model, scenario.seed, time),
  );
  for (let dof = 0; dof < load.length; dof++) load[dof] = load[dof]! + increment[dof]!;
  return load;
}

/** Unit-amplitude wind load for DAF reference. */
export function windIncrementUnit3d(scenario: WindScenario3d): Float64Array {
  return windIncrementForMultiplier3d(scenario, 1);
}

function windIncrementForMultiplier3d(scenario: WindScenario3d, multiplier: number): Float64Array {
  const load = new Float64Array(scenario.mesh.ndof);
  const q = scenario.model.amplitudekNm * 1000 * multiplier;
  const dir = windDirectionUnit(scenario.model.directionDeg);
  const { coords, elements } = scenario.mesh;

  for (const element of elements) {
    const ax = coords[3 * element.na]!;
    const ay = coords[3 * element.na + 1]!;
    const az = coords[3 * element.na + 2]!;
    const bx = coords[3 * element.nb]!;
    const by = coords[3 * element.nb + 1]!;
    const bz = coords[3 * element.nb + 2]!;
    const L = element.L;
    const ex = (bx - ax) / L;
    const ey = (by - ay) / L;
    const ez = (bz - az) / L;
    // |e × windDir| = sin(angle between member and wind).
    const cx = ey * dir.z - ez * dir.y;
    const cy = ez * dir.x - ex * dir.z;
    const cz = ex * dir.y - ey * dir.x;
    const sinAngle = Math.hypot(cx, cy, cz);
    const c = element.c ?? 0.1;
    const tributary = Math.max(sinAngle * L, 2 * c);
    const force = (q * tributary) / 2;
    const aDof = 6 * element.na;
    const bDof = 6 * element.nb;
    load[aDof] = load[aDof]! + force * dir.x;
    load[aDof + 1] = load[aDof + 1]! + force * dir.y;
    load[aDof + 2] = load[aDof + 2]! + force * dir.z;
    load[bDof] = load[bDof]! + force * dir.x;
    load[bDof + 1] = load[bDof + 1]! + force * dir.y;
    load[bDof + 2] = load[bDof + 2]! + force * dir.z;
  }
  return load;
}

export function initialWindState3d(
  scenario: WindScenario3d,
  modal?: EigenResult,
): NewmarkState | undefined {
  if (scenario.baseAnalysis.kind !== 'stable') return undefined;
  const omega1 = modal?.values[0];
  const omega2 = modal?.values[1] ?? (omega1 ? omega1 * 3 : undefined);
  if (!(omega1 && omega2)) return undefined;
  const damping = rayleighFit(scenario.model.zeta, omega1, omega2);
  const system = prepareNewmarkSystemAssembled(
    scenario.mesh,
    scenario.K,
    scenario.mass,
    scenario.dt,
    damping,
  );
  return {
    u: new Float64Array(scenario.baseAnalysis.result.u),
    v: new Float64Array(scenario.mesh.ndof),
    a: new Float64Array(scenario.mesh.ndof),
    t: 0,
    damping,
    system,
  };
}

export function stepWind3d(
  scenario: WindScenario3d,
  state: NewmarkState,
  substeps = 4,
): NewmarkState {
  if (!state.system || !state.damping)
    throw new Error('3D wind state is missing a prepared Newmark system.');
  let next = state;
  for (let index = 0; index < substeps; index++) {
    next = newmarkStepAssembled(
      scenario.mesh,
      next,
      (time) => windLoadAt3d(scenario, time),
      scenario.dt,
      state.damping,
      state.system,
    );
  }
  return next;
}

/**
 * Modal projection q_i = φ_iᵀ M u for the 3D wind explainer bars.
 */
export function modalCoordinates3d(
  mesh: AnalysisMesh3d,
  modal: EigenResult,
  u: Float64Array,
  mass: Float64Array,
): Float64Array {
  const count = modal.values.length;
  const output = new Float64Array(count);
  if (modal.vectors.length !== mesh.ndof * count || u.length !== mesh.ndof) return output;
  const Mu = matVec(mass, mesh.ndof, u);
  for (let mode = 0; mode < count; mode++) {
    let value = 0;
    for (let dof = 0; dof < mesh.ndof; dof++)
      value += modal.vectors[dof * count + mode]! * Mu[dof]!;
    output[mode] = value;
  }
  return output;
}

/**
 * Modal coordinates of the static response to a unit-amplitude wind load — the
 * denominator of the measured DAF. Solved via K uref = F_unit.
 */
export function windReferenceCoordinates3d(
  scenario: WindScenario3d,
  modal: EigenResult,
): Float64Array {
  const Funit = windIncrementUnit3d(scenario);
  const uref = solveDenseSPD(scenario.K, scenario.mesh.ndof, Funit, scenario.mesh.freeDofs);
  return modalCoordinates3d(scenario.mesh, modal, uref, scenario.mass);
}

function solveDenseSPD(
  K: Float64Array,
  ndof: number,
  F: Float64Array,
  freeDofs: Int32Array,
): Float64Array {
  const n = freeDofs.length;
  const Kff = new Float64Array(n * n);
  const Ff = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gi = freeDofs[i]!;
    Ff[i] = F[gi]!;
    for (let j = 0; j < n; j++) Kff[i * n + j] = K[gi * ndof + freeDofs[j]!]!;
  }
  // Solve Kff * uf = Ff by simple LU (Kff is SPD; Doolittle is fine for reference)
  const A = new Float64Array(Kff);
  const b = new Float64Array(Ff);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row * n + col]!) > Math.abs(A[pivot * n + col]!)) pivot = row;
    }
    if (pivot !== col) {
      for (let j = 0; j < n; j++) {
        const tmp = A[col * n + j]!;
        A[col * n + j] = A[pivot * n + j]!;
        A[pivot * n + j] = tmp;
      }
      const tmpb = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = tmpb;
    }
    const diag = A[col * n + col]!;
    if (Math.abs(diag) < 1e-30) return new Float64Array(ndof);
    for (let row = col + 1; row < n; row++) {
      const factor = A[row * n + col]! / diag;
      if (factor === 0) continue;
      A[row * n + col] = factor;
      for (let j = col + 1; j < n; j++) A[row * n + j] = A[row * n + j]! - factor * A[col * n + j]!;
      b[row] = b[row]! - factor * b[col]!;
    }
  }
  const uf = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i]!;
    for (let j = i + 1; j < n; j++) sum -= A[i * n + j]! * uf[j]!;
    uf[i] = sum / A[i * n + i]!;
  }
  const u = new Float64Array(ndof);
  for (let i = 0; i < n; i++) u[freeDofs[i]!] = uf[i]!;
  return u;
}

function matVec(matrix: Float64Array, size: number, vector: Float64Array): Float64Array {
  const out = new Float64Array(size);
  for (let row = 0; row < size; row++) {
    let value = 0;
    for (let column = 0; column < size; column++)
      value += matrix[row * size + column]! * vector[column]!;
    out[row] = value;
  }
  return out;
}

/**
 * Ratio between the currently-dominant modal coordinate amplitude and its
 * static reference — the honest measured dynamic amplification.
 */
export function measuredDaf3d(
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

/**
 * Three-part resonance detector matching §4.6 (forcing within ±10 % of f_i,
 * envelope growth ≥ 1.5× over five forcing cycles, ζ < 5 %). Dimension-agnostic.
 */
export function detectResonance3d(
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

function windMultiplier(
  story: Extract<StorySpec3d, { kind: 'wind' }>,
  seed: number,
  time: number,
): number {
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
