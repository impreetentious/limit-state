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
    const K = assembleK3d(mesh);
    const mass = assembleM3d(mesh);
    // Recover the static load that produced the base equilibrium by K·u
    // (point loads + any gravity already baked into the solved state).
    const baseLoad = new Float64Array(mesh.ndof);
    for (let row = 0; row < mesh.ndof; row++) {
      let value = 0;
      for (let col = 0; col < mesh.ndof; col++) value += K[row * mesh.ndof + col]! * baseAnalysis.result.u[col]!;
      baseLoad[row] = value;
    }
    return {
      mesh,
      baseAnalysis,
      baseLoad,
      dt: 1 / 240,
      mass,
      K,
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
  const increment = windIncrementForMultiplier3d(scenario, windMultiplier(scenario.model, scenario.seed, time));
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

export function initialWindState3d(scenario: WindScenario3d, modal?: EigenResult): NewmarkState | undefined {
  if (scenario.baseAnalysis.kind !== 'stable') return undefined;
  const omega1 = modal?.values[0];
  const omega2 = modal?.values[1] ?? (omega1 ? omega1 * 3 : undefined);
  if (!(omega1 && omega2)) return undefined;
  const damping = rayleighFit(scenario.model.zeta, omega1, omega2);
  const system = prepareNewmarkSystemAssembled(scenario.mesh, scenario.K, scenario.mass, scenario.dt, damping);
  return {
    u: new Float64Array(scenario.baseAnalysis.result.u),
    v: new Float64Array(scenario.mesh.ndof),
    a: new Float64Array(scenario.mesh.ndof),
    t: 0,
    damping,
    system,
  };
}

export function stepWind3d(scenario: WindScenario3d, state: NewmarkState, substeps = 4): NewmarkState {
  if (!state.system || !state.damping) throw new Error('3D wind state is missing a prepared Newmark system.');
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

function windMultiplier(story: Extract<StorySpec3d, { kind: 'wind' }>, seed: number, time: number): number {
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
