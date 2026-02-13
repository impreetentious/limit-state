/**
 * Tension-only cable iteration for space-frame members.
 * docs/FEM-SPEC.md §14 2E / 3X.
 */
import { assembleLoadCase3d, type LoadAssembly3d } from './assemble';
import { buildMesh3d } from './mesh';
import { solveStatic3d, type StaticAnalysis3d } from './statics';
import type { AnalysisOptions3d, EditorModel3d, MemberSpec3d } from './types';

const MAX_CABLE_ITERATIONS = 10;
const SLACK_FORCE = 1e-6;
const REACTIVATE_ELONGATION = 1e-12;

export interface CableSolveResult3d {
  analysis: StaticAnalysis3d;
  activeCables: number[];
  slackCables: number[];
  iterations: number;
  frozen: boolean;
}

/** True when any member is marked cableOnly. docs/FEM-SPEC.md §14 3X. */
export function modelHasCables3d(model: EditorModel3d): boolean {
  return model.members.some((member) => member.cableOnly);
}

/**
 * Static solve with iterative slack removal for `cableOnly` members.
 * `loadFactor` scales gravity and point loads together; `options` carries the
 * analysis flags (Timoshenko) through every iteration. docs/FEM-SPEC.md §14 3X / 4H.
 */
export function solveTensionOnly3d(
  model: EditorModel3d,
  loadFactor = 1,
  options: AnalysisOptions3d = {},
): CableSolveResult3d {
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
      analysis: solveScaled3d(model, loadFactor, options),
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
  let analysis: StaticAnalysis3d = { kind: 'invalid', message: 'Cable iteration did not run.' };

  for (let iter = 0; iter < MAX_CABLE_ITERATIONS; iter++) {
    iterations = iter + 1;
    const reduced = withActiveCables3d(model, active);
    analysis = solveScaled3d(reduced, loadFactor, options);
    if (analysis.kind !== 'stable') {
      return summarize(analysis, cableIds, active, iterations, frozen);
    }

    const next = new Set(active);
    for (const id of cableIds) {
      const N = memberAxial3d(analysis, id);
      if (active.has(id)) {
        if (N < -SLACK_FORCE) next.delete(id);
      } else if (cableElongation3d(analysis, model, id) > REACTIVATE_ELONGATION) {
        next.add(id);
      }
    }

    const key = [...next].sort((a, b) => a - b).join(',');
    if (sameSet(active, next)) {
      active = next;
      break;
    }
    if (history.includes(key)) {
      frozen = true;
      active = next;
      break;
    }
    history.push([...active].sort((a, b) => a - b).join(','));
    active = next;
    if (iter === MAX_CABLE_ITERATIONS - 1) frozen = true;
  }

  analysis = solveScaled3d(withActiveCables3d(model, active), loadFactor, options);
  return summarize(analysis, cableIds, active, iterations, frozen);
}

function summarize(
  analysis: StaticAnalysis3d,
  cableIds: number[],
  active: ReadonlySet<number>,
  iterations: number,
  frozen: boolean,
): CableSolveResult3d {
  return {
    analysis,
    activeCables: [...active].sort((a, b) => a - b),
    slackCables: cableIds.filter((id) => !active.has(id)).sort((a, b) => a - b),
    iterations,
    frozen,
  };
}

function solveScaled3d(
  model: EditorModel3d,
  loadFactor: number,
  options: AnalysisOptions3d,
): StaticAnalysis3d {
  try {
    const mesh = buildMesh3d(model, options);
    const nodeIndex = new Map<number, number>();
    for (let index = 0; index < mesh.editorNode.length; index++) {
      const id = mesh.editorNode[index]!;
      if (id >= 0) nodeIndex.set(id, index);
    }
    const points = model.loads.points.flatMap((point) => {
      const meshNode = nodeIndex.get(point.node);
      return meshNode === undefined
        ? []
        : [
            {
              meshNode,
              fx: point.fx,
              fy: point.fy,
              fz: point.fz,
              mx: point.mx,
              my: point.my,
              mz: point.mz,
            },
          ];
    });
    const base = assembleLoadCase3d(mesh, { gravity: model.loads.gravity, points });
    const loads = scaleLoadAssembly3d(base, loadFactor);
    return solveStatic3d(mesh, loads.F, undefined, loads.elementFixedEnd);
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : 'Cable analysis could not run.',
    };
  }
}

export function scaleLoadAssembly3d(loads: LoadAssembly3d, factor: number): LoadAssembly3d {
  const F = new Float64Array(loads.F.length);
  const elementFixedEnd = new Float64Array(loads.elementFixedEnd.length);
  for (let index = 0; index < F.length; index++) F[index] = loads.F[index]! * factor;
  for (let index = 0; index < elementFixedEnd.length; index++)
    elementFixedEnd[index] = loads.elementFixedEnd[index]! * factor;
  return { F, elementFixedEnd };
}

function withActiveCables3d(model: EditorModel3d, active: ReadonlySet<number>): EditorModel3d {
  return {
    ...model,
    members: model.members.filter((member) => !member.cableOnly || active.has(member.id)),
    deck: (model.deck ?? []).filter((id) => {
      const member = model.members.find((candidate) => candidate.id === id);
      if (!member?.cableOnly) return true;
      return active.has(id);
    }),
  };
}

/** Tension-positive axial from end-A convention N = −Fx. docs/FEM-SPEC.md §4.9. */
function memberAxial3d(
  analysis: Extract<StaticAnalysis3d, { kind: 'stable' }>,
  memberId: number,
): number {
  let N = 0;
  let found = false;
  for (let index = 0; index < analysis.mesh.elements.length; index++) {
    if (analysis.mesh.elements[index]!.memberId !== memberId) continue;
    const value = -analysis.result.elementForces[index * 12]!;
    if (!found || Math.abs(value) >= Math.abs(N)) N = value;
    found = true;
  }
  return found ? N : 0;
}

function cableElongation3d(
  analysis: Extract<StaticAnalysis3d, { kind: 'stable' }>,
  model: EditorModel3d,
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
  const ax = analysis.mesh.coords[3 * na]!;
  const ay = analysis.mesh.coords[3 * na + 1]!;
  const az = analysis.mesh.coords[3 * na + 2]!;
  const bx = analysis.mesh.coords[3 * nb]!;
  const by = analysis.mesh.coords[3 * nb + 1]!;
  const bz = analysis.mesh.coords[3 * nb + 2]!;
  const L = Math.hypot(bx - ax, by - ay, bz - az);
  if (!(L > 0)) return 0;
  const ex = (bx - ax) / L;
  const ey = (by - ay) / L;
  const ez = (bz - az) / L;
  const dux = analysis.result.u[6 * nb]! - analysis.result.u[6 * na]!;
  const duy = analysis.result.u[6 * nb + 1]! - analysis.result.u[6 * na + 1]!;
  const duz = analysis.result.u[6 * nb + 2]! - analysis.result.u[6 * na + 2]!;
  return dux * ex + duy * ey + duz * ez;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Ensure cable members carry bending releases (keep torsion). docs/FEM-SPEC.md §14 3X. */
export function normalizeCableMember3d(member: MemberSpec3d): MemberSpec3d {
  if (!member.cableOnly) return member;
  return {
    ...member,
    releaseA: { tx: false, ty: true, tz: true },
    releaseB: { tx: false, ty: true, tz: true },
  };
}
