/**
 * Tension-only cable iteration: deactivate members in compression, re-solve,
 * reactivate if axial elongation returns tension; freeze after 10 iterations.
 */
import { assembleLoadCase, type LoadAssembly } from './assemble';
import { buildMesh } from './mesh';
import { solveStatic, type StaticAnalysis } from './statics';
import type { AnalysisOptions, EditorModel, MemberSpec } from './types';

const MAX_CABLE_ITERATIONS = 10;
/** Axial force below this (N) counts as slack / inactive. */
const SLACK_FORCE = 1e-6;
/** Elongation above this (m) reactivates a slack cable. */
const REACTIVATE_ELONGATION = 1e-12;

export interface CableSolveResult {
  analysis: StaticAnalysis;
  /** Cable member ids that remain active (taut) after iteration. */
  activeCables: number[];
  /** Cable member ids deactivated as slack. */
  slackCables: number[];
  iterations: number;
  /** True when the oscillation / iteration guard froze the active set. */
  frozen: boolean;
}

/** True when the model declares any tension-only cable members. */
export function modelHasCables(model: EditorModel): boolean {
  return model.members.some((member) => member.cableOnly);
}

/**
 * Static solve with iterative slack removal for `cableOnly` members.
 * `loadFactor` scales gravity and point loads together (ramp / failure path).
 */
export function solveTensionOnly(
  model: EditorModel,
  options: AnalysisOptions = {},
  loadFactor = 1,
): CableSolveResult {
  if (!(loadFactor > 0) || !Number.isFinite(loadFactor)) {
    return {
      analysis: { kind: 'invalid', message: 'Cable load factor must be finite and positive.' },
      activeCables: [],
      slackCables: [],
      iterations: 0,
      frozen: false,
    };
  }

  const cableIds = model.members.filter((member) => member.cableOnly).map((member) => member.id);
  if (cableIds.length === 0) {
    return {
      analysis: solveScaled(model, options, loadFactor),
      activeCables: [],
      slackCables: [],
      iterations: 0,
      frozen: false,
    };
  }

  let active = new Set(cableIds);
  const history: string[] = [];
  let frozen = false;
  let iterations = 0;
  let analysis: StaticAnalysis = { kind: 'invalid', message: 'Cable iteration did not run.' };

  for (let iter = 0; iter < MAX_CABLE_ITERATIONS; iter++) {
    iterations = iter + 1;
    const reduced = withActiveCables(model, active);
    analysis = solveScaled(reduced, options, loadFactor);
    if (analysis.kind !== 'stable') {
      return summarize(analysis, cableIds, active, iterations, frozen);
    }

    const next = new Set(active);
    for (const id of cableIds) {
      const N = memberAxial(analysis, id);
      if (active.has(id)) {
        if (N < -SLACK_FORCE) next.delete(id);
      } else if (cableElongation(analysis, model, id) > REACTIVATE_ELONGATION) {
        next.add(id);
      }
    }

    const key = [...next].sort((a, b) => a - b).join(',');
    if (sameSet(active, next)) {
      active = next;
      break;
    }
    if (history.includes(key)) {
      // A→B→A (or longer) oscillation — freeze on the newly proposed set.
      frozen = true;
      active = next;
      break;
    }
    history.push([...active].sort((a, b) => a - b).join(','));
    active = next;
    if (iter === MAX_CABLE_ITERATIONS - 1) frozen = true;
  }

  analysis = solveScaled(withActiveCables(model, active), options, loadFactor);
  return summarize(analysis, cableIds, active, iterations, frozen);
}

function summarize(
  analysis: StaticAnalysis,
  cableIds: number[],
  active: ReadonlySet<number>,
  iterations: number,
  frozen: boolean,
): CableSolveResult {
  return {
    analysis,
    activeCables: [...active].sort((a, b) => a - b),
    slackCables: cableIds.filter((id) => !active.has(id)).sort((a, b) => a - b),
    iterations,
    frozen,
  };
}

function solveScaled(
  model: EditorModel,
  options: AnalysisOptions,
  loadFactor: number,
): StaticAnalysis {
  try {
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
    const base = assembleLoadCase(mesh, { gravity: model.loads.gravity, points });
    return solveStatic(mesh, scaleLoadAssembly(base, loadFactor));
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : 'Cable analysis could not run.',
    };
  }
}

function scaleLoadAssembly(loads: LoadAssembly, factor: number): LoadAssembly {
  const F = new Float64Array(loads.F.length);
  const elementFixedEnd = new Float64Array(loads.elementFixedEnd.length);
  const elementTransverseUdl = new Float64Array(loads.elementTransverseUdl.length);
  for (let index = 0; index < F.length; index++) F[index] = loads.F[index]! * factor;
  for (let index = 0; index < elementFixedEnd.length; index++)
    elementFixedEnd[index] = loads.elementFixedEnd[index]! * factor;
  for (let index = 0; index < elementTransverseUdl.length; index++)
    elementTransverseUdl[index] = loads.elementTransverseUdl[index]! * factor;
  return { F, elementFixedEnd, elementTransverseUdl };
}

function withActiveCables(model: EditorModel, active: ReadonlySet<number>): EditorModel {
  return {
    ...model,
    members: model.members.filter((member) => !member.cableOnly || active.has(member.id)),
    deck: model.deck.filter((id) => {
      const member = model.members.find((candidate) => candidate.id === id);
      if (!member?.cableOnly) return true;
      return active.has(id);
    }),
  };
}

function memberAxial(
  analysis: Extract<StaticAnalysis, { kind: 'stable' }>,
  memberId: number,
): number {
  let N = 0;
  let found = false;
  for (let index = 0; index < analysis.mesh.elements.length; index++) {
    if (analysis.mesh.elements[index]!.memberId !== memberId) continue;
    const value = analysis.result.elementForces[index * 5]!;
    if (!found || Math.abs(value) >= Math.abs(N)) N = value;
    found = true;
  }
  return found ? N : 0;
}

/** Axial elongation (u_b − u_a)·ê of a cable's chord from the current displacement. */
function cableElongation(
  analysis: Extract<StaticAnalysis, { kind: 'stable' }>,
  model: EditorModel,
  memberId: number,
): number {
  const member = model.members.find((candidate) => candidate.id === memberId);
  if (!member) return 0;
  let na = -1;
  let nb = -1;
  for (let node = 0; node < analysis.mesh.editorNode.length; node++) {
    if (analysis.mesh.editorNode[node] === member.a) na = node;
    if (analysis.mesh.editorNode[node] === member.b) nb = node;
  }
  if (na < 0 || nb < 0) return 0;
  const ax = analysis.mesh.coords[2 * na]!;
  const ay = analysis.mesh.coords[2 * na + 1]!;
  const bx = analysis.mesh.coords[2 * nb]!;
  const by = analysis.mesh.coords[2 * nb + 1]!;
  const L = Math.hypot(bx - ax, by - ay);
  if (!(L > 0)) return 0;
  const ex = (bx - ax) / L;
  const ey = (by - ay) / L;
  const dux = analysis.result.u[3 * nb]! - analysis.result.u[3 * na]!;
  const duy = analysis.result.u[3 * nb + 1]! - analysis.result.u[3 * na + 1]!;
  return dux * ex + duy * ey;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Ensure cable members carry truss releases. */
export function normalizeCableMember(member: MemberSpec): MemberSpec {
  if (!member.cableOnly) return member;
  return { ...member, releaseA: true, releaseB: true };
}
