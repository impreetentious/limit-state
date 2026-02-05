/**
 * 3D P-Δ (geometric) second-order statics: iterate K + K_g(N) → re-solve →
 * update N until ‖ΔN‖/‖N‖ < 1e−6. Parallels §14 2B on space-frame meshes.
 */
import { expandFreeVector, factorLDLT, freeMatrix, freeVector, solveFactored } from '../solve';
import {
  assembleK3dDense,
  assembleKg3d,
  assembleLoadCase3d,
  elementLocalStiffness3d,
} from './assemble';
import { buildMesh3d } from './mesh';
import { analyzeStaticModel3d } from './statics';
import type { AnalysisMesh3d, AnalysisOptions3d, EditorModel3d, StaticResult3d } from './types';

const RELATIVE_N_TOLERANCE = 1e-6;
const MAX_ITERATIONS = 20;

export type SecondOrderAnalysis3d =
  | {
      kind: 'stable';
      mesh: AnalysisMesh3d;
      result: StaticResult3d;
      linear: StaticResult3d;
      iterations: number;
      momentAmplification: number;
      displacementAmplification: number;
    }
  | { kind: 'mechanism'; message: string }
  | { kind: 'divergent'; message: string; iterations: number }
  | { kind: 'invalid'; message: string };

/**
 * Iterative geometric-nonlinear static solve on a 3D model.
 */
export function solveSecondOrderStatic3d(
  model: EditorModel3d,
  options: AnalysisOptions3d = {},
): SecondOrderAnalysis3d {
  if (model.members.some((member) => member.cableOnly))
    return {
      kind: 'invalid',
      message:
        'P-Δ is unavailable while tension-only cables are active; use the cable iteration alone.',
    };
  let mesh: AnalysisMesh3d;
  let F: Float64Array;
  let elementFixedEnd: Float64Array;
  try {
    mesh = buildMesh3d(model, options);
    const loads = assembleLoadCase3d(mesh, {
      gravity: model.loads.gravity,
      points: model.loads.points
        .map((point) => ({
          meshNode: nodeIndex(mesh, point.node),
          fx: point.fx,
          fy: point.fy,
          fz: point.fz,
          mx: point.mx,
          my: point.my,
          mz: point.mz,
        }))
        .filter((p) => p.meshNode >= 0),
    });
    F = loads.F;
    elementFixedEnd = loads.elementFixedEnd;
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : 'P-Δ setup failed.',
    };
  }

  const linear = analyzeStaticModel3d(model, options);
  if (linear.kind !== 'stable') {
    if (linear.kind === 'mechanism') return { kind: 'mechanism', message: linear.message };
    return { kind: 'invalid', message: linear.message };
  }

  const K = assembleK3dDense(mesh);
  const ndof = mesh.ndof;
  let previousN = elementAxial3d(linear.result, mesh.elements.length);
  let currentResult = linear.result;
  let iterations = 0;

  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    const Kg = assembleKg3d(mesh, previousN);
    const Keff = new Float64Array(K.length);
    for (let i = 0; i < K.length; i++) Keff[i] = K[i]! + Kg[i]!;

    const factored = factorLDLT(freeMatrix(Keff, ndof, mesh.freeDofs), mesh.freeDofs.length);
    if (!factored.ok) {
      return {
        kind: 'divergent',
        iterations,
        message: 'P-Δ iteration lost stiffness — buckling-adjacent instability.',
      };
    }
    const uf = solveFactored(factored.factor, freeVector(F, mesh.freeDofs));
    const u = expandFreeVector(ndof, mesh.freeDofs, uf);
    const nextResult = recoverResult(mesh, u, elementFixedEnd);
    const nextN = elementAxial3d(nextResult, mesh.elements.length);
    const relative = relativeChange(previousN, nextN);
    currentResult = nextResult;
    previousN = nextN;

    if (relative < RELATIVE_N_TOLERANCE) {
      return {
        kind: 'stable',
        mesh,
        result: currentResult,
        linear: linear.result,
        iterations,
        momentAmplification: momentAmplification3d(linear.result, currentResult),
        displacementAmplification: displacementAmplification3d(linear.result.u, currentResult.u),
      };
    }
    if (relative > 1e3) {
      return {
        kind: 'divergent',
        iterations,
        message: 'P-Δ iteration diverged — axial forces grew without bound (buckling-adjacent).',
      };
    }
  }
  return {
    kind: 'divergent',
    iterations: MAX_ITERATIONS,
    message: `P-Δ did not converge within ${MAX_ITERATIONS} iterations.`,
  };
}

/** Tension-positive axial force per element from 3D element force blocks (12 per element). */
export function elementAxial3d(result: StaticResult3d, elementCount: number): Float64Array {
  const N = new Float64Array(elementCount);
  for (let index = 0; index < elementCount; index++) {
    // At end A the local Fx reaction is compressive-positive: tension N = −Fx_a.
    N[index] = -result.elementForces[index * 12]!;
  }
  return N;
}

function nodeIndex(mesh: AnalysisMesh3d, editorId: number): number {
  for (let node = 0; node < mesh.editorNode.length; node++)
    if (mesh.editorNode[node] === editorId) return node;
  return -1;
}

function recoverResult(
  mesh: AnalysisMesh3d,
  u: Float64Array,
  elementFixedEnd: Float64Array,
): StaticResult3d {
  const elementForces = new Float64Array(mesh.elements.length * 12);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const k = elementLocalStiffness3d(element, mesh.shearFlexible === true);
    const ug = new Float64Array(12);
    const a = 6 * element.na;
    const b = 6 * element.nb;
    for (let i = 0; i < 6; i++) {
      ug[i] = u[a + i]!;
      ug[6 + i] = u[b + i]!;
    }
    const ul = new Float64Array(12);
    for (let blk = 0; blk < 4; blk++) {
      const o = blk * 3;
      const gx = ug[o]!;
      const gy = ug[o + 1]!;
      const gz = ug[o + 2]!;
      const R = element.R;
      ul[o] = R[0]! * gx + R[1]! * gy + R[2]! * gz;
      ul[o + 1] = R[3]! * gx + R[4]! * gy + R[5]! * gz;
      ul[o + 2] = R[6]! * gx + R[7]! * gy + R[8]! * gz;
    }
    for (let i = 0; i < 12; i++) {
      let force = 0;
      for (let j = 0; j < 12; j++) force += k[i * 12 + j]! * ul[j]!;
      elementForces[index * 12 + i] = force - (elementFixedEnd[index * 12 + i] ?? 0);
    }
  }
  return { u, elementForces, utilization: new Map(), reactions: new Map() };
}

function relativeChange(previous: Float64Array, next: Float64Array): number {
  let num = 0;
  let den = 0;
  for (let index = 0; index < previous.length; index++) {
    const d = next[index]! - previous[index]!;
    num += d * d;
    den += next[index]! * next[index]!;
  }
  if (den === 0) return num === 0 ? 0 : Infinity;
  return Math.sqrt(num / den);
}

function momentAmplification3d(linear: StaticResult3d, second: StaticResult3d): number {
  const m0 = peakMoment3d(linear);
  const m1 = peakMoment3d(second);
  if (m0 === 0) return m1 === 0 ? 1 : Infinity;
  return m1 / m0;
}

function peakMoment3d(result: StaticResult3d): number {
  let peak = 0;
  for (let index = 0; index < result.elementForces.length; index += 12) {
    peak = Math.max(
      peak,
      Math.abs(result.elementForces[index + 4]!),
      Math.abs(result.elementForces[index + 5]!),
      Math.abs(result.elementForces[index + 10]!),
      Math.abs(result.elementForces[index + 11]!),
    );
  }
  return peak;
}

function displacementAmplification3d(linear: Float64Array, second: Float64Array): number {
  let u0 = 0;
  let u1 = 0;
  for (let index = 0; index < linear.length; index++) {
    u0 = Math.max(u0, Math.abs(linear[index]!));
    u1 = Math.max(u1, Math.abs(second[index]!));
  }
  if (u0 === 0) return u1 === 0 ? 1 : Infinity;
  return u1 / u0;
}
