/**
 * P-Δ (geometric) second-order statics: iterate K + K_g(N) → re-solve → update N
 * until ‖ΔN‖/‖N‖ < 1e−6.
 */
import { assembleK, assembleKg, type LoadAssembly } from './assemble';
import { factorLDLT, freeMatrix, mechanismEditorNode } from './solve';
import { solveStatic, type StaticAnalysis } from './statics';
import type { AnalysisMesh, StaticResult } from './types';

const RELATIVE_N_TOLERANCE = 1e-6;
const MAX_ITERATIONS = 20;

export type SecondOrderAnalysis =
  | {
      kind: 'stable';
      mesh: AnalysisMesh;
      loads: LoadAssembly;
      result: StaticResult;
      linear: StaticResult;
      iterations: number;
      momentAmplification: number;
      displacementAmplification: number;
    }
  | { kind: 'mechanism'; nodeId: number; message: string }
  | { kind: 'divergent'; message: string; iterations: number }
  | { kind: 'invalid'; message: string };

/**
 * Geometric nonlinear (P-Δ) static solve by successive K + K_g updates.
 * Converge on ‖ΔN‖_rel < 1e−6; divergence ⇒ buckling-adjacent.
 *
 * Displacements come from (K+K_g)u = F; member forces recover from elastic k
 * (engineering beam theory); support reactions use the current K_eff.
 */
export function solveSecondOrderStatic(mesh: AnalysisMesh, loads: LoadAssembly): SecondOrderAnalysis {
  const linear = solveStatic(mesh, loads);
  if (linear.kind !== 'stable') {
    if (linear.kind === 'mechanism') return linear;
    return { kind: 'invalid', message: linear.message };
  }

  const K = assembleK(mesh);
  let previousN = elementAxial(linear.result, mesh.elements.length);
  let current: Extract<StaticAnalysis, { kind: 'stable' }> = linear;
  let iterations = 0;

  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    const Kg = assembleKg(mesh, previousN);
    const Keff = addMatrices(K, Kg);
    const factored = factorLDLT(freeMatrix(Keff, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
    if (!factored.ok) {
      const nodeId = mechanismEditorNode(mesh, factored.mechanism.freeDofIndex);
      return {
        kind: 'divergent',
        iterations,
        message: `P-Δ iteration lost stiffness near node ${nodeId} — buckling-adjacent instability.`,
      };
    }

    const next = solveStatic(mesh, loads, { ndof: mesh.ndof, K: Keff, factor: factored.factor });
    if (next.kind !== 'stable') {
      return {
        kind: 'divergent',
        iterations,
        message: 'P-Δ iteration could not recover a stable force state.',
      };
    }

    const nextN = elementAxial(next.result, mesh.elements.length);
    const relative = relativeChange(previousN, nextN);
    current = next;
    previousN = nextN;

    if (relative < RELATIVE_N_TOLERANCE) {
      return {
        kind: 'stable',
        mesh,
        loads,
        result: current.result,
        linear: linear.result,
        iterations,
        momentAmplification: momentAmplification(linear.result, current.result),
        displacementAmplification: displacementAmplification(linear.result.u, current.result.u),
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
    message: `P-Δ did not converge within ${MAX_ITERATIONS} iterations — buckling-adjacent instability.`,
  };
}

/** Per-element tension-positive axial force from a static result. */
export function elementAxial(result: StaticResult, elementCount: number): Float64Array {
  if (result.elementForces.length < elementCount * 5) {
    throw new Error('Static result does not carry one force record per analysis element.');
  }
  const N = new Float64Array(elementCount);
  for (let index = 0; index < elementCount; index++) N[index] = result.elementForces[index * 5]!;
  return N;
}

function addMatrices(A: Float64Array, B: Float64Array): Float64Array {
  if (A.length !== B.length) throw new Error('Matrix add requires equal lengths.');
  const out = new Float64Array(A.length);
  for (let index = 0; index < A.length; index++) out[index] = A[index]! + B[index]!;
  return out;
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

/** Peak |M| ratio (second / linear) over all element end moments. */
function momentAmplification(linear: StaticResult, second: StaticResult): number {
  const m0 = peakMoment(linear);
  const m1 = peakMoment(second);
  if (m0 === 0) return m1 === 0 ? 1 : Infinity;
  return m1 / m0;
}

function peakMoment(result: StaticResult): number {
  let peak = 0;
  for (let index = 0; index < result.elementForces.length; index += 5) {
    peak = Math.max(peak, Math.abs(result.elementForces[index + 2]!), Math.abs(result.elementForces[index + 4]!));
  }
  return peak;
}

function displacementAmplification(linear: Float64Array, second: Float64Array): number {
  let u0 = 0;
  let u1 = 0;
  for (let index = 0; index < linear.length; index++) {
    u0 = Math.max(u0, Math.abs(linear[index]!));
    u1 = Math.max(u1, Math.abs(second[index]!));
  }
  if (u0 === 0) return u1 === 0 ? 1 : Infinity;
  return u1 / u0;
}
