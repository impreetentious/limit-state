/**
 * Static result recovery: constrained solve, local element end forces,
 * utilization, and support reactions.
 */
import { assembleK, assembleLoadCase, elementLocalStiffness, type LoadAssembly } from './assemble';
import { buildMesh } from './mesh';
import { expandFreeVector, factorLDLT, freeMatrix, freeVector, mechanismEditorNode, solveFactored } from './solve';
import type { AnalysisMesh, EditorModel, StaticResult } from './types';

export type StaticAnalysis =
  | { kind: 'stable'; mesh: AnalysisMesh; loads: LoadAssembly; result: StaticResult }
  | { kind: 'mechanism'; nodeId: number; message: string }
  | { kind: 'invalid'; message: string };

export interface DeformationDisplay {
  maxMeters: number;
  scale: number;
}

/** Solve one assembled static load case and recover all displayed result values. */
export function solveStatic(mesh: AnalysisMesh, loads: LoadAssembly): StaticAnalysis {
  const K = assembleK(mesh);
  const factor = factorLDLT(freeMatrix(K, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  if (!factor.ok) {
    const nodeId = mechanismEditorNode(mesh, factor.mechanism.freeDofIndex);
    return { kind: 'mechanism', nodeId, message: `Node ${nodeId} can move freely — add a support or member.` };
  }
  const u = expandFreeVector(mesh.ndof, mesh.freeDofs, solveFactored(factor.factor, freeVector(loads.F, mesh.freeDofs)));
  const elementForces = recoverElementForces(mesh, u, loads.elementFixedEnd);
  return {
    kind: 'stable',
    mesh,
    loads,
    result: {
      u,
      elementForces,
      utilization: recoverUtilization(mesh, elementForces),
      reactions: recoverReactions(mesh, K, u, loads.F),
    },
  };
}

/** Build the model's base static load case (self-weight plus editor point loads). */
export function analyzeStaticModel(model: EditorModel): StaticAnalysis {
  try {
    const mesh = buildMesh(model);
    const nodeIndex = new Map<number, number>();
    for (let index = 0; index < mesh.editorNode.length; index++) {
      const id = mesh.editorNode[index]!;
      if (id >= 0) nodeIndex.set(id, index);
    }
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined ? [] : [{ meshNode, fx: point.fx, fy: point.fy }];
    });
    return solveStatic(mesh, assembleLoadCase(mesh, { gravity: model.loads.gravity, points }));
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : 'Static analysis could not run.' };
  }
}

/** Honest display amplification sized to a legible 28 px maximum displacement. */
export function deformationDisplay(mesh: AnalysisMesh, u: Float64Array, pixelsPerMeter: number): DeformationDisplay {
  let maxMeters = 0;
  for (let node = 0; mesh.coords.length > node * 2; node++) {
    maxMeters = Math.max(maxMeters, Math.hypot(u[3 * node]!, u[3 * node + 1]!));
  }
  if (maxMeters === 0) return { maxMeters, scale: 1 };
  return { maxMeters, scale: Math.max(1, Math.min(100_000, 28 / (maxMeters * pixelsPerMeter))) };
}

/** Element force recovery f_local = k_cond(Tu_e) − f_fixedEnd. */
function recoverElementForces(mesh: AnalysisMesh, u: Float64Array, fixedEnd: Float64Array): Float64Array {
  const out = new Float64Array(mesh.elements.length * 5);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const localU = localElementDisplacement(u, element.na, element.nb, element.cos, element.sin);
    const stiffness = elementLocalStiffness(element);
    const localForce = new Float64Array(6);
    for (let row = 0; row < 6; row++) {
      let value = -fixedEnd[index * 6 + row]!;
      for (let column = 0; column < 6; column++) value += stiffness[row * 6 + column]! * localU[column]!;
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
function recoverUtilization(mesh: AnalysisMesh, forces: Float64Array): Map<number, number> {
  const utilization = new Map<number, number>();
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const offset = index * 5;
    const N = forces[offset]!;
    const ma = forces[offset + 2]!;
    const mb = forces[offset + 4]!;
    const endpointUtilization = Math.max(
      fiberUtilization(N, ma, element.A, element.I, element.c, element.fy),
      fiberUtilization(N, mb, element.A, element.I, element.c, element.fy),
    );
    utilization.set(element.memberId, Math.max(utilization.get(element.memberId) ?? 0, endpointUtilization));
  }
  return utilization;
}

function fiberUtilization(N: number, M: number, A: number, I: number, c: number, fy: number): number {
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
    for (let column = 0; column < mesh.ndof; column++) value += K[row * mesh.ndof + column]! * u[column]!;
    residual[row] = value;
  }
  const reactions = new Map<number, { fx: number; fy: number; m: number }>();
  for (let node = 0; node < mesh.editorNode.length; node++) {
    const id = mesh.editorNode[node]!;
    if (id >= 0) reactions.set(id, { fx: residual[3 * node]!, fy: residual[3 * node + 1]!, m: residual[3 * node + 2]! });
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
  for (const [offset, node] of [[0, na], [3, nb]] as const) {
    const x = u[3 * node]!;
    const y = u[3 * node + 1]!;
    local[offset] = cos * x + sin * y;
    local[offset + 1] = -sin * x + cos * y;
    local[offset + 2] = u[3 * node + 2]!;
  }
  return local;
}
