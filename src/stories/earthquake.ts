/**
 * Earthquake-story controller: horizontal base excitation −M·ι·ü_g(t) on top of
 * the static gravity/point-load equilibrium. Parallels the wind story.
 */
import { assembleM } from '../fem/assemble';
import {
  baseExcitationLoad,
  influenceVectorX,
  newmarkStep,
  prepareNewmarkSystem,
  rayleighFit,
  type NewmarkState,
} from '../fem/dynamics';
import { buildMesh } from '../fem/mesh';
import { earthquakeRecord, groundAccelAt, type GroundMotionRecord } from '../fem/records';
import { responseSpectrum, type ResponseSpectrum } from '../fem/spectrum';
import { analyzeStaticModel, utilizationAtDisplacement, type StaticAnalysis } from '../fem/statics';
import type { AnalysisMesh, AnalysisOptions, EditorModel, EigenResult } from '../fem/types';

export interface EarthquakeScenario {
  mesh: AnalysisMesh;
  baseAnalysis: StaticAnalysis;
  baseLoad: Float64Array;
  baseFixedEnd: Float64Array;
  dt: number;
  mass: Float64Array;
  iota: Float64Array;
  record: GroundMotionRecord;
  scale: number;
  zeta: number;
  spectrum: ResponseSpectrum;
  duration: number;
}

/** Prepare mesh, mass, influence vector, and spectrum for one earthquake run. */
export function prepareEarthquake(
  model: EditorModel,
  options: AnalysisOptions = {},
): EarthquakeScenario | undefined {
  if (model.story.kind !== 'earthquake') return undefined;
  try {
    const mesh = buildMesh(model, options);
    const baseAnalysis = analyzeStaticModel(model, { ...options, secondOrder: false });
    const baseLoad =
      baseAnalysis.kind === 'stable'
        ? new Float64Array(baseAnalysis.loads.F)
        : new Float64Array(mesh.ndof);
    const baseFixedEnd =
      baseAnalysis.kind === 'stable'
        ? new Float64Array(baseAnalysis.loads.elementFixedEnd)
        : new Float64Array(mesh.elements.length * 6);
    const record = earthquakeRecord(model.story.record);
    const mass = assembleM(mesh);
    const iota = influenceVectorX(mesh);
    const scaled = scaleRecord(record, model.story.scale);
    return {
      mesh,
      baseAnalysis,
      baseLoad,
      baseFixedEnd,
      dt: 1 / 240,
      mass,
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

/** Absolute nodal load at time t: gravity/points + −M·ι·ü_g(t). */
export function earthquakeLoadAt(scenario: EarthquakeScenario, time: number): Float64Array {
  const load = new Float64Array(scenario.baseLoad);
  const ug = groundAccelAt(scenario.record, time);
  const excitation = baseExcitationLoad(scenario.mass, scenario.mesh.ndof, scenario.iota, ug);
  for (let dof = 0; dof < load.length; dof++) load[dof] = load[dof]! + excitation[dof]!;
  return load;
}

/** Zero-velocity Newmark state around static equilibrium. */
export function initialEarthquakeState(
  scenario: EarthquakeScenario,
  modal?: EigenResult,
): NewmarkState | undefined {
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
    system: prepareNewmarkSystem(scenario.mesh, scenario.dt, damping),
  };
}

/** Advance one display frame (four 1/240 s Newmark substeps). */
export function stepEarthquake(
  scenario: EarthquakeScenario,
  state: NewmarkState,
  substeps = 4,
): NewmarkState {
  let next = state;
  for (let index = 0; index < substeps; index++) {
    next = newmarkStep(
      scenario.mesh,
      next,
      (time) => earthquakeLoadAt(scenario, time),
      scenario.dt,
    );
  }
  return next;
}

/** Combined-stress utilization under the dynamic displacement. */
export function earthquakeUtilization(
  scenario: EarthquakeScenario,
  u: Float64Array,
): Map<number, number> {
  return utilizationAtDisplacement(scenario.mesh, u, scenario.baseFixedEnd);
}

function scaleRecord(record: GroundMotionRecord, scale: number): GroundMotionRecord {
  if (!(scale > 0) || !Number.isFinite(scale))
    throw new Error('Earthquake scale must be finite and positive.');
  if (scale === 1) return record;
  const accel = new Float64Array(record.accel.length);
  for (let i = 0; i < accel.length; i++) accel[i] = record.accel[i]! * scale;
  return { ...record, accel };
}
