/**
 * Plastic pushover for space-frame meshes.
 * Hinges form when √(My²+Mz²) reaches M_p = Z·f_y; releases θy+θz.
 */
import { MATERIALS, plasticMoment } from '../materials';
import { analyzeAtFactor3d } from './failure';
import type { EditorModel3d, EndReleases3d } from './types';

const MAX_PUSHOVER_STEPS = 24;
const MOMENT_TOL = 1e-9;

export interface PushoverHinge3d {
  memberId: number;
  end: 'a' | 'b';
  loadFactor: number;
}

export interface PushoverPoint3d {
  loadFactor: number;
  baseShear: number;
  roofDisp: number;
  hinges: PushoverHinge3d[];
}

export interface PushoverResult3d {
  points: PushoverPoint3d[];
  hinges: PushoverHinge3d[];
  collapseLoadFactor: number;
  collapseBaseShear: number;
  outcome: 'mechanism' | 'stable' | 'capped';
}

type SectionKey = `${number}:${'a' | 'b'}`;

/**
 * Event-to-event plastic pushover under the model's horizontal point-load pattern.
 * Gravity is off for the classic portal gate.
 */
export function runPushover3d(model: EditorModel3d): PushoverResult3d {
  const reference = { ...model, loads: { gravity: false, points: model.loads.points } };
  if (reference.loads.points.length === 0) {
    return { points: [], hinges: [], collapseLoadFactor: 0, collapseBaseShear: 0, outcome: 'stable' };
  }

  let current = cloneModel3d(reference);
  const hinges: PushoverHinge3d[] = [];
  const points: PushoverPoint3d[] = [];
  const moments = new Map<SectionKey, number>();
  let loadFactor = 0;

  for (let step = 0; step < MAX_PUSHOVER_STEPS; step++) {
    const unit = analyzeAtFactor3d(current, 1);
    if (unit.kind === 'mechanism') return finish(points, hinges, loadFactor, 'mechanism');
    if (unit.kind !== 'stable') return finish(points, hinges, loadFactor, 'stable');

    const event = nextPathEvent(current, unit, moments, loadFactor);
    if (!event) {
      const state = analyzeAtFactor3d(current, Math.max(loadFactor, 1e-9));
      if (state.kind === 'stable' && loadFactor > 0) points.push(samplePoint(state, loadFactor, hinges));
      return finish(points, hinges, loadFactor > 0 ? loadFactor : 1, 'stable');
    }

    if (!Number.isFinite(event.loadFactor) || event.loadFactor > 1e12) {
      return finish(points, hinges, loadFactor, 'capped');
    }

    const delta = event.loadFactor - loadFactor;
    for (const member of current.members) {
      if (member.cableOnly) continue;
      for (const end of ['a', 'b'] as const) {
        if (end === 'a' && (member.releaseA.ty || member.releaseA.tz)) continue;
        if (end === 'b' && (member.releaseB.ty || member.releaseB.tz)) continue;
        const key = sectionKey(member.id, end);
        const Mu = endMoment(unit, member.id, end);
        moments.set(key, (moments.get(key) ?? 0) + delta * Mu);
      }
    }

    loadFactor = event.loadFactor;
    const atEvent = analyzeAtFactor3d(current, loadFactor);
    if (atEvent.kind === 'mechanism') return finish(points, hinges, loadFactor, 'mechanism');
    if (atEvent.kind !== 'stable') return finish(points, hinges, loadFactor, 'capped');

    hinges.push({ memberId: event.memberId, end: event.end, loadFactor });
    points.push(samplePoint(atEvent, loadFactor, hinges));

    current = insertHinge(current, event.memberId, event.end, atEvent);
    moments.set(sectionKey(event.memberId, event.end), 0);

    const check = analyzeAtFactor3d(current, loadFactor);
    if (check.kind === 'mechanism') return finish(points, hinges, loadFactor, 'mechanism');
  }

  return finish(points, hinges, loadFactor, 'capped');
}

function finish(
  points: PushoverPoint3d[],
  hinges: PushoverHinge3d[],
  loadFactor: number,
  outcome: PushoverResult3d['outcome'],
): PushoverResult3d {
  const last = points[points.length - 1];
  return {
    points,
    hinges,
    collapseLoadFactor: loadFactor,
    collapseBaseShear: last?.baseShear ?? 0,
    outcome,
  };
}

function nextPathEvent(
  model: EditorModel3d,
  unit: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>,
  moments: ReadonlyMap<SectionKey, number>,
  loadFactor: number,
): { memberId: number; end: 'a' | 'b'; loadFactor: number } | undefined {
  let best: { memberId: number; end: 'a' | 'b'; loadFactor: number } | undefined;
  for (const member of model.members) {
    if (member.cableOnly) continue;
    const Mp = plasticMoment(member.section, MATERIALS[member.material].fy);
    if (!(Mp > 0)) continue;
    for (const end of ['a', 'b'] as const) {
      if (end === 'a' && (member.releaseA.ty || member.releaseA.tz)) continue;
      if (end === 'b' && (member.releaseB.ty || member.releaseB.tz)) continue;
      const key = sectionKey(member.id, end);
      const M0 = moments.get(key) ?? 0;
      const Mu = endMoment(unit, member.id, end);
      if (Math.abs(Mu) < MOMENT_TOL) continue;
      const remaining = Mp - Math.abs(M0);
      if (remaining <= Mp * 1e-10) {
        if (!best || loadFactor < best.loadFactor) best = { memberId: member.id, end, loadFactor };
        continue;
      }
      const toward = Math.sign(M0) === 0 ? Math.sign(Mu) : Math.sign(M0);
      if (Math.sign(Mu) !== toward && Math.sign(M0) !== 0) continue;
      const delta = remaining / Math.abs(Mu);
      const next = loadFactor + delta;
      if (!(next > loadFactor)) continue;
      if (!best || next < best.loadFactor) best = { memberId: member.id, end, loadFactor: next };
    }
  }
  return best;
}

function sectionKey(memberId: number, end: 'a' | 'b'): SectionKey {
  return `${memberId}:${end}`;
}

function endMoment(
  analysis: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>,
  memberId: number,
  end: 'a' | 'b',
): number {
  const indices = analysis.mesh.elements.flatMap((element, index) => (element.memberId === memberId ? [index] : []));
  if (indices.length === 0) return 0;
  if (end === 'a') {
    const i = indices[0]!;
    return Math.hypot(analysis.result.elementForces[i * 12 + 4]!, analysis.result.elementForces[i * 12 + 5]!);
  }
  const i = indices[indices.length - 1]!;
  return Math.hypot(analysis.result.elementForces[i * 12 + 10]!, analysis.result.elementForces[i * 12 + 11]!);
}

function samplePoint(
  analysis: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>,
  loadFactor: number,
  hinges: readonly PushoverHinge3d[],
): PushoverPoint3d {
  return {
    loadFactor,
    baseShear: baseShear(analysis),
    roofDisp: roofDisplacement(analysis),
    hinges: hinges.map((hinge) => ({ ...hinge })),
  };
}

function baseShear(analysis: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>): number {
  let shear = 0;
  for (const reaction of analysis.result.reactions.values()) {
    shear += Math.hypot(reaction.fx, reaction.fy);
  }
  return shear;
}

function roofDisplacement(analysis: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>): number {
  let bestZ = -Infinity;
  let bestU = 0;
  for (let node = 0; node < analysis.mesh.editorNode.length; node++) {
    if (analysis.mesh.editorNode[node]! < 0) continue;
    const z = analysis.mesh.coords[3 * node + 2]!;
    if (z >= bestZ) {
      bestZ = z;
      bestU = Math.hypot(analysis.result.u[6 * node]!, analysis.result.u[6 * node + 1]!);
    }
  }
  return bestU;
}

function insertHinge(model: EditorModel3d, memberId: number, end: 'a' | 'b', analysis: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>): EditorModel3d {
  const axis = governingBendAxis(analysis, memberId, end);
  return {
    ...model,
    members: model.members.map((member) => {
      if (member.id !== memberId) return member;
      const prior = end === 'a' ? member.releaseA : member.releaseB;
      const release: EndReleases3d = axis === 'y'
        ? { ...prior, ty: true }
        : { ...prior, tz: true };
      return end === 'a' ? { ...member, releaseA: release } : { ...member, releaseB: release };
    }),
  };
}

function governingBendAxis(
  analysis: Extract<ReturnType<typeof analyzeAtFactor3d>, { kind: 'stable' }>,
  memberId: number,
  end: 'a' | 'b',
): 'y' | 'z' {
  const indices = analysis.mesh.elements.flatMap((element, index) => (element.memberId === memberId ? [index] : []));
  if (indices.length === 0) return 'z';
  const i = end === 'a' ? indices[0]! : indices[indices.length - 1]!;
  const My = Math.abs(analysis.result.elementForces[i * 12 + (end === 'a' ? 4 : 10)]!);
  const Mz = Math.abs(analysis.result.elementForces[i * 12 + (end === 'a' ? 5 : 11)]!);
  return My >= Mz ? 'y' : 'z';
}

function cloneModel3d(model: EditorModel3d): EditorModel3d {
  return {
    ...model,
    nodes: model.nodes.map((node) => ({ ...node })),
    members: model.members.map((member) => ({
      ...member,
      section: { ...member.section },
      releaseA: { ...member.releaseA },
      releaseB: { ...member.releaseB },
    })),
    supports: model.supports.map((support) => ({ ...support })),
    loads: { gravity: model.loads.gravity, points: model.loads.points.map((point) => ({ ...point })) },
    deck: model.deck ? [...model.deck] : undefined,
    story: model.story ? { ...model.story } : undefined,
  };
}
