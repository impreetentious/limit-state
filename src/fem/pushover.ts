/**
 * Plastic pushover: event-to-event lateral load with plastic-hinge insertion
 * when |M| reaches M_p = Z·f_y. docs/FEM-SPEC.md §14 2F (reuses §4.7 hinge cascade).
 *
 * Moments at non-hinged sections are carried forward along the load path;
 * after a hinge is inserted, further moment increments use the new unit-load
 * field so collapse tracks the plastic mechanism load (not first yield).
 */
import { MATERIALS, plasticMoment } from './materials';
import { analyzeAtFactor } from './failure';
import type { AnalysisOptions, EditorModel } from './types';

const MAX_PUSHOVER_STEPS = 24;
const MOMENT_TOL = 1e-9;

interface PushoverHinge {
  memberId: number;
  end: 'a' | 'b';
  loadFactor: number;
}

interface PushoverPoint {
  /** Proportional factor on the model's lateral reference loads. */
  loadFactor: number;
  /** Total base shear (sum of support |R_x| resisting the lateral pattern), N. */
  baseShear: number;
  /** Absolute roof (highest free node) horizontal displacement, m. */
  roofDisp: number;
  hinges: PushoverHinge[];
}

export interface PushoverResult {
  points: PushoverPoint[];
  hinges: PushoverHinge[];
  collapseLoadFactor: number;
  collapseBaseShear: number;
  outcome: 'mechanism' | 'stable' | 'capped';
}

type SectionKey = `${number}:${'a' | 'b'}`;

/**
 * Event-to-event plastic pushover under the model's current point-load pattern
 * (gravity off for the classic portal gate). docs/FEM-SPEC.md §14 2F.
 */
export function runPushover(model: EditorModel, options: AnalysisOptions = {}): PushoverResult {
  const reference = { ...model, loads: { gravity: false, points: model.loads.points } };
  if (reference.loads.points.length === 0) {
    return {
      points: [],
      hinges: [],
      collapseLoadFactor: 0,
      collapseBaseShear: 0,
      outcome: 'stable',
    };
  }

  let current = cloneModel(reference);
  const hinges: PushoverHinge[] = [];
  const points: PushoverPoint[] = [];
  const moments = new Map<SectionKey, number>();
  let loadFactor = 0;

  for (let step = 0; step < MAX_PUSHOVER_STEPS; step++) {
    const unit = analyzeAtFactor(current, 1, options);
    if (unit.kind === 'mechanism') return finish(points, hinges, loadFactor, 'mechanism');
    if (unit.kind !== 'stable') return finish(points, hinges, loadFactor, 'stable');

    const event = nextPathEvent(current, unit, moments, loadFactor);
    if (!event) {
      const state = analyzeAtFactor(current, Math.max(loadFactor, 1e-9), options);
      if (state.kind === 'stable' && loadFactor > 0)
        points.push(samplePoint(state, loadFactor, hinges));
      return finish(points, hinges, loadFactor > 0 ? loadFactor : 1, 'stable');
    }

    if (!Number.isFinite(event.loadFactor) || event.loadFactor > 1e12) {
      return finish(points, hinges, loadFactor, 'capped');
    }

    const delta = event.loadFactor - loadFactor;
    // Advance locked path moments with the current unit field.
    for (const member of current.members) {
      if (member.cableOnly) continue;
      for (const end of ['a', 'b'] as const) {
        if (end === 'a' && member.releaseA) continue;
        if (end === 'b' && member.releaseB) continue;
        const key = sectionKey(member.id, end);
        const Mu = endMoment(unit, member.id, end);
        moments.set(key, (moments.get(key) ?? 0) + delta * Mu);
      }
    }

    loadFactor = event.loadFactor;
    const atEvent = analyzeAtFactor(current, loadFactor, options);
    if (atEvent.kind === 'mechanism') return finish(points, hinges, loadFactor, 'mechanism');
    if (atEvent.kind !== 'stable') return finish(points, hinges, loadFactor, 'capped');

    hinges.push({ memberId: event.memberId, end: event.end, loadFactor });
    points.push(samplePoint(atEvent, loadFactor, hinges));

    current = insertHinge(current, event.memberId, event.end);
    moments.set(sectionKey(event.memberId, event.end), 0);

    const check = analyzeAtFactor(current, loadFactor, options);
    if (check.kind === 'mechanism') return finish(points, hinges, loadFactor, 'mechanism');
  }

  return finish(points, hinges, loadFactor, 'capped');
}

function finish(
  points: PushoverPoint[],
  hinges: PushoverHinge[],
  loadFactor: number,
  outcome: PushoverResult['outcome'],
): PushoverResult {
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
  model: EditorModel,
  unit: Extract<ReturnType<typeof analyzeAtFactor>, { kind: 'stable' }>,
  moments: ReadonlyMap<SectionKey, number>,
  loadFactor: number,
): { memberId: number; end: 'a' | 'b'; loadFactor: number } | undefined {
  let best: { memberId: number; end: 'a' | 'b'; loadFactor: number } | undefined;
  for (const member of model.members) {
    if (member.cableOnly) continue;
    const Mp = plasticMoment(member.section, MATERIALS[member.material].fy);
    if (!(Mp > 0)) continue;
    for (const end of ['a', 'b'] as const) {
      if (end === 'a' && member.releaseA) continue;
      if (end === 'b' && member.releaseB) continue;
      const key = sectionKey(member.id, end);
      const M0 = moments.get(key) ?? 0;
      const Mu = endMoment(unit, member.id, end);
      if (Math.abs(Mu) < MOMENT_TOL) continue;
      const remaining = Mp - Math.abs(M0);
      if (remaining <= Mp * 1e-10) {
        // Already at capacity — form immediately at current load.
        if (!best || loadFactor < best.loadFactor) best = { memberId: member.id, end, loadFactor };
        continue;
      }
      // Require the unit moment to grow |M| toward Mp.
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
  analysis: Extract<ReturnType<typeof analyzeAtFactor>, { kind: 'stable' }>,
  memberId: number,
  end: 'a' | 'b',
): number {
  const indices = analysis.mesh.elements.flatMap((element, index) =>
    element.memberId === memberId ? [index] : [],
  );
  if (indices.length === 0) return 0;
  if (end === 'a') return -analysis.result.elementForces[indices[0]! * 5 + 2]!;
  return analysis.result.elementForces[indices[indices.length - 1]! * 5 + 4]!;
}

function samplePoint(
  analysis: Extract<ReturnType<typeof analyzeAtFactor>, { kind: 'stable' }>,
  loadFactor: number,
  hinges: readonly PushoverHinge[],
): PushoverPoint {
  return {
    loadFactor,
    baseShear: baseShear(analysis),
    roofDisp: roofDisplacement(analysis),
    hinges: hinges.map((hinge) => ({ ...hinge })),
  };
}

function baseShear(
  analysis: Extract<ReturnType<typeof analyzeAtFactor>, { kind: 'stable' }>,
): number {
  let shear = 0;
  for (const reaction of analysis.result.reactions.values()) shear += Math.abs(reaction.fx);
  return shear;
}

function roofDisplacement(
  analysis: Extract<ReturnType<typeof analyzeAtFactor>, { kind: 'stable' }>,
): number {
  let bestY = -Infinity;
  let bestUx = 0;
  for (let node = 0; node < analysis.mesh.editorNode.length; node++) {
    if (analysis.mesh.editorNode[node]! < 0) continue;
    const y = analysis.mesh.coords[2 * node + 1]!;
    if (y >= bestY) {
      bestY = y;
      bestUx = analysis.result.u[3 * node]!;
    }
  }
  return Math.abs(bestUx);
}

function insertHinge(model: EditorModel, memberId: number, end: 'a' | 'b'): EditorModel {
  return {
    ...model,
    members: model.members.map((member) => {
      if (member.id !== memberId) return member;
      return end === 'a' ? { ...member, releaseA: true } : { ...member, releaseB: true };
    }),
    loads: {
      gravity: model.loads.gravity,
      points: model.loads.points.map((point) => ({ ...point })),
    },
    deck: [...model.deck],
  };
}

function cloneModel(model: EditorModel): EditorModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => ({ ...node })),
    members: model.members.map((member) => ({ ...member, section: { ...member.section } })),
    supports: model.supports.map((support) => ({ ...support })),
    loads: {
      gravity: model.loads.gravity,
      points: model.loads.points.map((point) => ({ ...point })),
    },
    deck: [...model.deck],
    story: { ...model.story },
  };
}
