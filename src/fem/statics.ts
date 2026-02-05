/**
 * Static result recovery: constrained solve, local element end forces,
 * utilization, and support reactions.
 */
import { assembleK, assembleLoadCase, elementLocalStiffness, type LoadAssembly } from './assemble';
import { modelHasCables, solveTensionOnly } from './cables';
import { buildMesh } from './mesh';
import { solveSecondOrderStatic, type SecondOrderAnalysis } from './second-order';
import {
  expandFreeVector,
  factorLDLT,
  freeMatrix,
  freeVector,
  mechanismEditorNode,
  solveFactored,
  type Factor,
} from './solve';
import type { AnalysisMesh, AnalysisOptions, EditorModel, StaticResult } from './types';

export type StaticAnalysis =
  | {
      kind: 'stable';
      mesh: AnalysisMesh;
      loads: LoadAssembly;
      result: StaticResult;
      /** Present when AnalysisOptions.secondOrder produced a converged P-Δ solve. */
      secondOrder?: {
        linear: StaticResult;
        iterations: number;
        momentAmplification: number;
        displacementAmplification: number;
      };
    }
  | { kind: 'mechanism'; nodeId: number; message: string }
  | { kind: 'divergent'; message: string; iterations: number }
  | { kind: 'invalid'; message: string };

export interface DeformationDisplay {
  maxMeters: number;
  scale: number;
}

/** Factored static stiffness retained by moving-load stories. */
export type StaticSystem =
  | { ndof: number; K: Float64Array; factor: Factor }
  | { ndof: number; K: Float64Array; mechanismFreeDof: number };

/** Assemble and factor a model once; subsequent load cases take only back-substitution. */
export function prepareStaticSystem(mesh: AnalysisMesh): StaticSystem {
  const K = assembleK(mesh);
  const result = factorLDLT(freeMatrix(K, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  return result.ok
    ? { ndof: mesh.ndof, K, factor: result.factor }
    : { ndof: mesh.ndof, K, mechanismFreeDof: result.mechanism.freeDofIndex };
}

/** Solve one assembled static load case and recover all displayed result values. */
export function solveStatic(
  mesh: AnalysisMesh,
  loads: LoadAssembly,
  cachedSystem?: StaticSystem,
): StaticAnalysis {
  const system = cachedSystem ?? prepareStaticSystem(mesh);
  if (system.ndof !== mesh.ndof)
    return { kind: 'invalid', message: 'Static system does not match this analysis mesh.' };
  if ('mechanismFreeDof' in system) {
    const nodeId = mechanismEditorNode(mesh, system.mechanismFreeDof);
    return {
      kind: 'mechanism',
      nodeId,
      message: `Node ${nodeId} can move freely — add a support or member.`,
    };
  }
  const u = expandFreeVector(
    mesh.ndof,
    mesh.freeDofs,
    solveFactored(system.factor, freeVector(loads.F, mesh.freeDofs)),
  );
  const elementForces = recoverElementForces(mesh, u, loads.elementFixedEnd);
  const utilization = recoverUtilization(mesh, elementForces, loads.elementTransverseUdl);
  return {
    kind: 'stable',
    mesh,
    loads,
    result: {
      u,
      elementForces,
      utilization: utilization.values,
      utilizationStationM: utilization.stations,
      reactions: recoverReactions(mesh, system.K, u, loads.F),
    },
  };
}

/** Build the model's base static load case (self-weight plus editor point loads). */
export function analyzeStaticModel(
  model: EditorModel,
  options: AnalysisOptions = {},
): StaticAnalysis {
  try {
    if (modelHasCables(model)) {
      if (options.secondOrder) {
        return {
          kind: 'invalid',
          message: 'P-Δ second-order is not combined with tension-only cables in v1.',
        };
      }
      return solveTensionOnly(model, options).analysis;
    }
    const mesh = buildMesh(model, options);
    const nodeIndex = new Map<number, number>();
    for (let index = 0; index < mesh.editorNode.length; index++) {
      const id = mesh.editorNode[index]!;
      if (id >= 0) nodeIndex.set(id, index);
    }
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined ? [] : [{ meshNode, fx: point.fx, fy: point.fy }];
    });
    const loads = assembleLoadCase(mesh, { gravity: model.loads.gravity, points });
    if (options.secondOrder) return asStaticAnalysis(solveSecondOrderStatic(mesh, loads));
    return solveStatic(mesh, loads);
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : 'Static analysis could not run.',
    };
  }
}

function asStaticAnalysis(second: SecondOrderAnalysis): StaticAnalysis {
  if (second.kind === 'stable') {
    return {
      kind: 'stable',
      mesh: second.mesh,
      loads: second.loads,
      result: second.result,
      secondOrder: {
        linear: second.linear,
        iterations: second.iterations,
        momentAmplification: second.momentAmplification,
        displacementAmplification: second.displacementAmplification,
      },
    };
  }
  return second;
}

/** Honest display amplification sized to a legible 28 px maximum displacement. */
export function deformationDisplay(
  mesh: AnalysisMesh,
  u: Float64Array,
  pixelsPerMeter: number,
): DeformationDisplay {
  let maxMeters = 0;
  for (let node = 0; mesh.coords.length > node * 2; node++) {
    maxMeters = Math.max(maxMeters, Math.hypot(u[3 * node]!, u[3 * node + 1]!));
  }
  if (maxMeters === 0) return { maxMeters, scale: 1 };
  return { maxMeters, scale: Math.max(1, Math.min(100_000, 28 / (maxMeters * pixelsPerMeter))) };
}

/** Recover combined-stress utilization from a prescribed displacement state. */
export function utilizationAtDisplacement(
  mesh: AnalysisMesh,
  u: Float64Array,
  fixedEnd: Float64Array,
): Map<number, number> {
  if (u.length !== mesh.ndof) throw new Error('Displacement vector does not match the mesh.');
  if (fixedEnd.length !== mesh.elements.length * 6)
    throw new Error('Fixed-end vector does not match the mesh.');
  return recoverUtilization(mesh, recoverElementForces(mesh, u, fixedEnd)).values;
}

/** Recover element end forces from a prescribed displacement state. */
export function elementForcesAtDisplacement(
  mesh: AnalysisMesh,
  u: Float64Array,
  fixedEnd: Float64Array,
): Float64Array {
  if (u.length !== mesh.ndof) throw new Error('Displacement vector does not match the mesh.');
  if (fixedEnd.length !== mesh.elements.length * 6)
    throw new Error('Fixed-end vector does not match the mesh.');
  return recoverElementForces(mesh, u, fixedEnd);
}

/** Element force recovery f_local = k_cond(Tu_e) − f_fixedEnd. */
function recoverElementForces(
  mesh: AnalysisMesh,
  u: Float64Array,
  fixedEnd: Float64Array,
): Float64Array {
  const out = new Float64Array(mesh.elements.length * 5);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const localU = localElementDisplacement(u, element.na, element.nb, element.cos, element.sin);
    const stiffness = elementLocalStiffness(element, mesh.shearFlexible);
    const localForce = new Float64Array(6);
    for (let row = 0; row < 6; row++) {
      let value = -fixedEnd[index * 6 + row]!;
      for (let column = 0; column < 6; column++)
        value += stiffness[row * 6 + column]! * localU[column]!;
      localForce[row] = value;
    }
    const offset = index * 5;
    // Element nodal force at end A is positive in local +x under compression;
    // publish the kernel's documented tension-positive internal N instead.
    out[offset] = -localForce[0]!;
    out[offset + 1] = localForce[1]!;
    out[offset + 2] = localForce[2]!;
    out[offset + 3] = localForce[4]!;
    out[offset + 4] = localForce[5]!;
  }
  return out;
}

/** Combined-stress endpoint utilization |N/A ± Mc/I| / fy. */
function recoverUtilization(
  mesh: AnalysisMesh,
  forces: Float64Array,
  elementTransverseUdl?: Float64Array,
): { values: Map<number, number>; stations: Map<number, number> } {
  const utilization = new Map<number, number>();
  const stations = new Map<number, number>();
  const memberOffset = new Map<number, number>();
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const offset = index * 5;
    const start = memberOffset.get(element.memberId) ?? 0;
    memberOffset.set(element.memberId, start + element.L);
    const N = forces[offset]!;
    const ma = forces[offset + 2]!;
    const mb = forces[offset + 4]!;
    const atA = fiberUtilization(N, ma, element.A, element.I, element.c, element.fy);
    const atB = fiberUtilization(N, mb, element.A, element.I, element.c, element.fy);
    let maximumUtilization = Math.max(atA, atB);
    let station = atA >= atB ? 0 : element.L;
    const localYLoad = elementTransverseUdl?.[index] ?? 0;
    // The published end-force convention stores the local-A internal shear and
    // moment with the opposite sign to an in-span free body. Convert once, then
    // apply M(x) = M1 + V1 x − w x² / 2 for downward-positive w.
    const w = -localYLoad;
    const v1 = -forces[offset + 1]!;
    const v2 = forces[offset + 3]!;
    if (!element.releaseA && !element.releaseB && w !== 0 && v1 * v2 < 0 && v1 !== v2) {
      const x = (element.L * v1) / (v1 - v2);
      if (x > 0 && x < element.L) {
        const moment = -ma + v1 * x - (w * x * x) / 2;
        const interior = fiberUtilization(N, moment, element.A, element.I, element.c, element.fy);
        if (interior > maximumUtilization) {
          maximumUtilization = interior;
          station = x;
        }
      }
    }
    if (maximumUtilization > (utilization.get(element.memberId) ?? -Infinity)) {
      utilization.set(element.memberId, maximumUtilization);
      stations.set(element.memberId, start + station);
    }
  }
  return { values: utilization, stations };
}

function fiberUtilization(
  N: number,
  M: number,
  A: number,
  I: number,
  c: number,
  fy: number,
): number {
  const axial = N / A;
  const bending = (M * c) / I;
  return Math.max(Math.abs(axial + bending), Math.abs(axial - bending)) / fy;
}

/** Reactions from R = Ku − F at original editor nodes. */
function recoverReactions(
  mesh: AnalysisMesh,
  K: Float64Array,
  u: Float64Array,
  F: Float64Array,
): Map<number, { fx: number; fy: number; m: number }> {
  const residual = new Float64Array(mesh.ndof);
  for (let row = 0; row < mesh.ndof; row++) {
    let value = -F[row]!;
    for (let column = 0; column < mesh.ndof; column++)
      value += K[row * mesh.ndof + column]! * u[column]!;
    residual[row] = value;
  }
  const reactions = new Map<number, { fx: number; fy: number; m: number }>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const id = mesh.editorNode[node]!;
    if (id >= 0)
      reactions.set(id, {
        fx: residual[3 * node]!,
        fy: residual[3 * node + 1]!,
        m: residual[3 * node + 2]!,
      });
  }
  return reactions;
}

/** Local displacement T u_e with R = [[c,s,0],[-s,c,0],[0,0,1]]. */
function localElementDisplacement(
  u: Float64Array,
  na: number,
  nb: number,
  cos: number,
  sin: number,
): Float64Array {
  const local = new Float64Array(6);
  for (const [offset, node] of [
    [0, na],
    [3, nb],
  ] as const) {
    const x = u[3 * node]!;
    const y = u[3 * node + 1]!;
    local[offset] = cos * x + sin * y;
    local[offset + 1] = -sin * x + cos * y;
    local[offset + 2] = u[3 * node + 2]!;
  }
  return local;
}
