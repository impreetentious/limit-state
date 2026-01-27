/**
 * 3D earthquake story: base excitation −M·ι·ü_g with horizontal ι (X by default).
 */
import {
  baseExcitationLoad,
  newmarkStepAssembled,
  prepareNewmarkSystemAssembled,
  rayleighFit,
  type NewmarkState,
} from '../fem/dynamics';
import { earthquakeRecord, groundAccelAt, type GroundMotionRecord } from '../fem/records';
import { responseSpectrum, type ResponseSpectrum } from '../fem/spectrum';
import {
  assembleK3dDense,
  assembleM3d,
  analyzeStaticModel3d,
  type AnalysisMesh3d,
  type EditorModel3d,
  type StaticAnalysis3d,
} from '../fem/space';
import { utilizationAtDisplacement3d } from '../fem/space/statics';
import type { EigenResult } from '../fem/types';

export interface EarthquakeScenario3d {
  mesh: AnalysisMesh3d;
  baseAnalysis: StaticAnalysis3d;
  baseLoad: Float64Array;
  baseFixedEnd: Float64Array;
  dt: number;
  mass: Float64Array;
  K: Float64Array;
  iota: Float64Array;
  record: GroundMotionRecord;
  scale: number;
  zeta: number;
  spectrum: ResponseSpectrum;
  duration: number;
}

/** Prepare mesh, mass, influence vector, and spectrum for one 3D earthquake run. */
export function prepareEarthquake3d(model: EditorModel3d): EarthquakeScenario3d | undefined {
  if (model.story?.kind !== 'earthquake') return undefined;
  try {
    const baseAnalysis = analyzeStaticModel3d(model);
    if (baseAnalysis.kind !== 'stable') return undefined;
    const { mesh } = baseAnalysis;
    const record = earthquakeRecord(model.story.record);
    const mass = assembleM3d(mesh);
    const K = assembleK3dDense(mesh);
    const iota = influenceVectorHorizontal3d(mesh);
    // Recover static equilibrium load from K·u (includes gravity FEF effects in u).
    const baseLoad = new Float64Array(mesh.ndof);
    for (let i = 0; i < mesh.ndof; i++) {
      let sum = 0;
      for (let j = 0; j < mesh.ndof; j++) sum += K[i * mesh.ndof + j]! * baseAnalysis.result.u[j]!;
      baseLoad[i] = sum;
    }
    const scaled = scaleRecord(record, model.story.scale);
    return {
      mesh,
      baseAnalysis,
      baseLoad,
      baseFixedEnd: new Float64Array(mesh.elements.length * 12),
      dt: 1 / 240,
      mass,
      K,
      iota,
      record: scaled,
      scale: model.story.scale,
      zeta: model.story.zeta,
      spectrum: responseSpectrum(scaled, model.story.zeta),
      duration: (scaled.accel.length - 1) * scaled.dt,
    };
  } catch {
    return undefined;
  }
}

/** ι with unity on global-X translational DOFs. */
export function influenceVectorHorizontal3d(mesh: AnalysisMesh3d, axis: 0 | 1 = 0): Float64Array {
  const iota = new Float64Array(mesh.ndof);
  for (let node = 0; mesh.ndof > node * 6; node++) iota[6 * node + axis] = 1;
  return iota;
}

export function earthquakeLoadAt3d(scenario: EarthquakeScenario3d, time: number): Float64Array {
  const load = new Float64Array(scenario.baseLoad);
  const ug = groundAccelAt(scenario.record, time);
  const excitation = baseExcitationLoad(scenario.mass, scenario.mesh.ndof, scenario.iota, ug);
  for (let dof = 0; dof < load.length; dof++) load[dof] = load[dof]! + excitation[dof]!;
  return load;
}

export function initialEarthquakeState3d(scenario: EarthquakeScenario3d, modal?: EigenResult): NewmarkState | undefined {
  if (scenario.baseAnalysis.kind !== 'stable') return undefined;
  const omega1 = modal?.values[0];
  const omega2 = modal?.values[1] ?? (omega1 ? omega1 * 3 : undefined);
  if (!(omega1 && omega2)) return undefined;
  const damping = rayleighFit(scenario.zeta, omega1, omega2);
  return {
    u: new Float64Array(scenario.baseAnalysis.result.u),
    v: new Float64Array(scenario.mesh.ndof),
    a: new Float64Array(scenario.mesh.ndof),
    t: 0,
    damping,
    system: prepareNewmarkSystemAssembled(scenario.mesh, scenario.K, scenario.mass, scenario.dt, damping),
  };
}

export function stepEarthquake3d(scenario: EarthquakeScenario3d, state: NewmarkState, substeps = 4): NewmarkState {
  let next = state;
  const damping = state.damping ?? { a: 0, b: 0 };
  const system = state.system
    ?? prepareNewmarkSystemAssembled(scenario.mesh, scenario.K, scenario.mass, scenario.dt, damping);
  for (let index = 0; index < substeps; index++) {
    next = newmarkStepAssembled(scenario.mesh, next, (time) => earthquakeLoadAt3d(scenario, time), scenario.dt, damping, system);
  }
  return { ...next, system };
}

export function earthquakeUtilization3d(scenario: EarthquakeScenario3d, u: Float64Array): Map<number, number> {
  return utilizationAtDisplacement3d(scenario.mesh, u, scenario.baseFixedEnd);
}

function scaleRecord(record: GroundMotionRecord, scale: number): GroundMotionRecord {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Earthquake scale must be finite and positive.');
  if (scale === 1) return record;
  const accel = new Float64Array(record.accel.length);
  for (let i = 0; i < accel.length; i++) accel[i] = record.accel[i]! * scale;
  return { ...record, accel };
}
