/**
 * Phase 3 workplane editor store — ground / elevation / custom draw into EditorModel3d.
 * docs/FEM-SPEC.md §14 Phase 3 Editor / closeout 3T. Schema v2 only; 2D store stays untouched.
 */
import { create } from 'zustand';
import { DEFAULT_SECTION } from '../fem/materials';
import type { MaterialId, SectionSpec } from '../fem/types';
import {
  NO_RELEASES,
  type EditorModel3d,
  type MemberSpec3d,
  type StorySpec3d,
  type SupportKind3d,
} from '../fem/space';
import { blankSpace3d } from '../presets/scenes3d';
import { extrudeModel3d, replicateModel3d, scaleVec, type Vec3 } from './ops3d';
import {
  frameExtrudeAxis,
  frameFromThreePoints,
  resolveWorkplaneFrame,
  type WorkplaneSpec,
} from './workplane';

export type EditorTool3d =
  'select' | 'node' | 'member' | 'support' | 'load' | 'deck' | 'delete' | 'workplane';
type ResultDiagram3d = 'none' | 'axial' | 'shear' | 'moment';

type Selection3d =
  | { kind: 'none' }
  | { kind: 'node'; id: number }
  | { kind: 'member'; id: number }
  /** Additive member selection used for bulk material/section edits. */
  | { kind: 'members'; ids: number[] };

/** Three-click custom workplane definition in progress. docs/FEM-SPEC.md §14 3T. */
type WorkplanePick =
  { step: 0 } | { step: 1; origin: Vec3 } | { step: 2; origin: Vec3; alongU: Vec3 };

interface EditorState3d {
  model: EditorModel3d;
  tool: EditorTool3d;
  workplane: WorkplaneSpec;
  workplanePick: WorkplanePick;
  gridSnap: boolean;
  selection: Selection3d;
  memberStart: number | null;
  notice: string | null;
  /** Extrude / replicate distance along the workplane normal (m). */
  extrudeDistance: number;
  /** Number of copies for extrude / replicate. */
  extrudeCount: number;
  /** Undo / redo snapshot stack. docs/FEM-SPEC.md §14 4G. */
  past: EditorModel3d[];
  future: EditorModel3d[];
  undo: () => void;
  redo: () => void;
  /** Result diagram overlay for 3D members. docs/FEM-SPEC.md §14 4F. */
  resultDiagram: ResultDiagram3d;
  setResultDiagram: (diagram: ResultDiagram3d) => void;
  /** Timoshenko (shear-flexible) element formulation for 3D statics. */
  shearFlexible: boolean;
  /** P-Δ second-order solve for 3D statics. */
  secondOrder: boolean;
  setShearFlexible: (enabled: boolean) => void;
  setSecondOrder: (enabled: boolean) => void;
  setTool: (tool: EditorTool3d) => void;
  setWorkplanePreset: (plane: 'ground' | 'xz' | 'yz') => void;
  beginCustomWorkplane: () => void;
  pickCustomWorkplanePoint: (point: Vec3) => void;
  setGridSnap: (snap: boolean) => void;
  setSelection: (selection: Selection3d) => void;
  setNotice: (notice: string | null) => void;
  setExtrudeDistance: (distance: number) => void;
  setExtrudeCount: (count: number) => void;
  loadModel: (model: EditorModel3d) => void;
  reset: () => void;
  addNodeAt: (x: number, y: number, z: number) => number;
  addMemberBetween: (a: number, b: number) => void;
  setSupportOnNode: (nodeId: number, kind?: SupportKind3d) => void;
  setSupport: (nodeId: number, kind: SupportKind3d | undefined) => void;
  updateNode: (nodeId: number, x: number, y: number, z: number) => void;
  updateMember: (
    memberId: number,
    patch: Partial<
      Pick<MemberSpec3d, 'material' | 'section' | 'releaseA' | 'releaseB' | 'roll' | 'cableOnly'>
    >,
  ) => void;
  updateMembers: (
    memberIds: readonly number[],
    patch: { material?: MaterialId; section?: SectionSpec },
  ) => void;
  addLoadOnNode: (nodeId: number) => void;
  deleteSelection: () => void;
  setMemberStart: (id: number | null) => void;
  setModelName: (name: string) => void;
  /** Extrude along workplane normal (or custom offset). docs/FEM-SPEC.md §14. */
  extrude: (offset?: Vec3) => void;
  /** Replicate along workplane normal without connecting struts. */
  replicate: (offset?: Vec3) => void;
  /** Set horizontal wind azimuth (degrees). Ensures a wind story exists. */
  setWindDirectionDeg: (directionDeg: number) => void;
  setWindStory: (partial: Partial<Extract<StorySpec3d, { kind: 'wind' }>>) => void;
  setTrafficStory: (partial?: Partial<Extract<StorySpec3d, { kind: 'traffic' }>>) => void;
  setRampStory: () => void;
  setPushoverStory: () => void;
  setEarthquakeStory: (partial?: Partial<Extract<StorySpec3d, { kind: 'earthquake' }>>) => void;
  toggleDeckMember: (memberId: number) => void;
}

const blankModel = (): EditorModel3d => ({
  v: 2,
  name: 'Blank space',
  seed: 1,
  nodes: [],
  members: [],
  supports: [],
  loads: { gravity: false, points: [] },
  deck: [],
});

function snapValue(value: number, enabled: boolean): number {
  return enabled ? Math.round(value * 2) / 2 : value;
}

const HISTORY_LIMIT_3D = 100;
export const MEMBER_HARD_LIMIT_3D = 200;
export const MEMBER_SOFT_LIMIT_3D = 120;

/** Deep-ish snapshot for undo/redo. Editor models stay small; clone the shell. */
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
    loads: { ...model.loads, points: model.loads.points.map((point) => ({ ...point })) },
    deck: model.deck ? [...model.deck] : undefined,
    story: model.story ? { ...model.story } : undefined,
  };
}

let nextId = 100;

export const useEditorStore3d = create<EditorState3d>((rawSet, get) => {
  type Patch = Partial<EditorState3d> | ((state: EditorState3d) => Partial<EditorState3d>);
  const withHistory = (
    state: EditorState3d,
    patch: Partial<EditorState3d>,
  ): Partial<EditorState3d> => {
    if (!('model' in patch) || patch.model === undefined || patch.model === state.model)
      return patch;
    return {
      ...patch,
      past: [...state.past, cloneModel3d(state.model)].slice(-HISTORY_LIMIT_3D),
      future: [],
    };
  };
  const set = (partial: Patch): void => {
    if (typeof partial === 'function') {
      // zustand accepts state → partial via its own overload; forward through rawSet.
      rawSet(
        (state) =>
          withHistory(
            state,
            (partial as (s: EditorState3d) => Partial<EditorState3d>)(state),
          ) as EditorState3d,
      );
      return;
    }
    rawSet((state) => withHistory(state, partial) as EditorState3d);
  };
  return {
    model: blankSpace3d(),
    tool: 'select',
    workplane: { kind: 'ground' },
    workplanePick: { step: 0 },
    gridSnap: true,
    selection: { kind: 'none' },
    memberStart: null,
    notice: 'Blank space — draw on the ground workplane, or open a 3D preset.',
    extrudeDistance: 5,
    extrudeCount: 1,
    past: [],
    future: [],
    resultDiagram: 'none',
    setResultDiagram: (resultDiagram) => rawSet({ resultDiagram }),
    shearFlexible: false,
    secondOrder: false,
    setShearFlexible: (shearFlexible) => rawSet({ shearFlexible }),
    setSecondOrder: (secondOrder) => rawSet({ secondOrder }),

    undo: () =>
      rawSet((state) => {
        const previous = state.past.at(-1);
        if (!previous) return {};
        return {
          model: cloneModel3d(previous),
          past: state.past.slice(0, -1),
          future: [cloneModel3d(state.model), ...state.future],
          selection: { kind: 'none' },
          memberStart: null,
        };
      }),
    redo: () =>
      rawSet((state) => {
        const next = state.future[0];
        if (!next) return {};
        return {
          model: cloneModel3d(next),
          past: [...state.past, cloneModel3d(state.model)].slice(-HISTORY_LIMIT_3D),
          future: state.future.slice(1),
          selection: { kind: 'none' },
          memberStart: null,
        };
      }),

    setTool: (tool) => set({ tool, memberStart: null }),
    setWorkplanePreset: (plane) =>
      set({
        workplane: { kind: plane },
        workplanePick: { step: 0 },
        notice: `Workplane ${plane === 'ground' ? 'Ground XY' : plane === 'xz' ? 'Elevation XZ' : 'Elevation YZ'}`,
      }),
    beginCustomWorkplane: () =>
      set({
        tool: 'workplane',
        workplanePick: { step: 0 },
        notice:
          'Custom workplane — click origin, then a second point along u, then a third to set the plane.',
      }),
    pickCustomWorkplanePoint: (point) => {
      const { workplanePick, gridSnap } = get();
      const snap = (p: Vec3): Vec3 =>
        gridSnap
          ? { x: snapValue(p.x, true), y: snapValue(p.y, true), z: snapValue(p.z, true) }
          : p;
      const p = snap(point);
      if (workplanePick.step === 0) {
        set({
          workplanePick: { step: 1, origin: p },
          notice: 'Custom workplane — click a second point to set the u axis.',
        });
        return;
      }
      if (workplanePick.step === 1) {
        set({
          workplanePick: { step: 2, origin: workplanePick.origin, alongU: p },
          notice: 'Custom workplane — click a third point off the u axis to finish.',
        });
        return;
      }
      const frame = frameFromThreePoints(workplanePick.origin, workplanePick.alongU, p);
      if (!frame) {
        set({
          notice: 'Custom workplane — points were collinear; try again.',
          workplanePick: { step: 0 },
        });
        return;
      }
      set({
        workplane: { kind: 'custom', frame },
        workplanePick: { step: 0 },
        tool: 'select',
        notice: 'Custom workplane set — draw on it; Extrude follows its normal.',
      });
    },
    setGridSnap: (gridSnap) => set({ gridSnap }),
    setSelection: (selection) => set({ selection }),
    setNotice: (notice) => set({ notice }),
    setExtrudeDistance: (extrudeDistance) =>
      set({ extrudeDistance: Math.max(0.1, extrudeDistance) }),
    setExtrudeCount: (extrudeCount) => set({ extrudeCount: Math.max(1, Math.floor(extrudeCount)) }),
    setMemberStart: (memberStart) => set({ memberStart }),
    setModelName: (name) => set((state) => ({ model: { ...state.model, name } })),

    loadModel: (model) => {
      nextId =
        Math.max(nextId, ...model.nodes.map((n) => n.id), ...model.members.map((m) => m.id), 100) +
        1;
      rawSet({
        model,
        past: [],
        future: [],
        selection: { kind: 'none' },
        memberStart: null,
        notice: null,
      });
    },

    reset: () =>
      rawSet({
        model: blankModel(),
        past: [],
        future: [],
        selection: { kind: 'none' },
        memberStart: null,
        workplane: { kind: 'ground' },
        workplanePick: { step: 0 },
        notice: 'Blank space — draw on the ground workplane, or open a 3D preset.',
      }),

    addNodeAt: (x, y, z) => {
      const { gridSnap, model } = get();
      const id = nextId++;
      const node = {
        id,
        x: snapValue(x, gridSnap),
        y: snapValue(y, gridSnap),
        z: snapValue(z, gridSnap),
      };
      set({
        model: { ...model, nodes: [...model.nodes, node] },
        selection: { kind: 'node', id },
        notice: `Node ${id} at (${node.x}, ${node.y}, ${node.z})`,
      });
      return id;
    },

    addMemberBetween: (a, b) => {
      if (a === b) return;
      const { model } = get();
      if (model.members.length >= MEMBER_HARD_LIMIT_3D) {
        rawSet({
          notice: `Member limit reached (${MEMBER_HARD_LIMIT_3D}). Simplify the model before adding more members.`,
          memberStart: null,
        });
        return;
      }
      if (model.members.some((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a))) {
        set({ notice: 'Member already exists between those nodes.', memberStart: null });
        return;
      }
      const id = nextId++;
      set({
        model: {
          ...model,
          members: [
            ...model.members,
            {
              id,
              a,
              b,
              material: 'steel-s355',
              section: DEFAULT_SECTION,
              releaseA: NO_RELEASES,
              releaseB: NO_RELEASES,
              roll: 0,
              cableOnly: false,
            },
          ],
        },
        selection: { kind: 'member', id },
        memberStart: null,
        notice: `Member ${id}`,
      });
    },

    setSupportOnNode: (nodeId, kind = 'pin') => {
      const { model } = get();
      if (!model.nodes.some((n) => n.id === nodeId)) return;
      const existing = model.supports.find((s) => s.node === nodeId);
      const order: SupportKind3d[] = ['pin', 'rollerX', 'rollerY', 'rollerZ', 'fixed'];
      const nextKind =
        kind ?? (existing ? order[(order.indexOf(existing.kind) + 1) % order.length]! : 'pin');
      const supports = model.supports.filter((s) => s.node !== nodeId);
      supports.push({ node: nodeId, kind: nextKind });
      set({
        model: { ...model, supports },
        selection: { kind: 'node', id: nodeId },
        notice: `Support ${nextKind} on node ${nodeId}`,
      });
    },

    setSupport: (nodeId, kind) => {
      const { model } = get();
      if (!model.nodes.some((node) => node.id === nodeId)) return;
      const supports = model.supports.filter((support) => support.node !== nodeId);
      if (kind !== undefined) supports.push({ node: nodeId, kind });
      set({ model: { ...model, supports }, selection: { kind: 'node', id: nodeId } });
    },

    updateNode: (nodeId, x, y, z) =>
      set((state) => ({
        model: {
          ...state.model,
          nodes: state.model.nodes.map((node) =>
            node.id === nodeId ? { ...node, x, y, z } : node,
          ),
        },
      })),

    updateMember: (memberId, patch) =>
      set((state) => ({
        model: {
          ...state.model,
          members: state.model.members.map((member) =>
            member.id === memberId ? { ...member, ...patch } : member,
          ),
        },
      })),

    updateMembers: (memberIds, patch) => {
      const ids = new Set(memberIds);
      set((state) => ({
        model: {
          ...state.model,
          members: state.model.members.map((member) =>
            ids.has(member.id) ? { ...member, ...patch } : member,
          ),
        },
      }));
    },

    addLoadOnNode: (nodeId) => {
      const { model } = get();
      if (!model.nodes.some((n) => n.id === nodeId)) return;
      const points = model.loads.points.filter((p) => p.node !== nodeId);
      points.push({ node: nodeId, fx: 0, fy: -10e3, fz: 0 });
      set({
        model: { ...model, loads: { ...model.loads, points } },
        selection: { kind: 'node', id: nodeId },
        notice: `−10 kN (global −Y) on node ${nodeId}`,
      });
    },

    deleteSelection: () => {
      const { selection, model } = get();
      if (selection.kind === 'node') {
        const id = selection.id;
        const removedMembers = new Set(
          model.members.filter((m) => m.a === id || m.b === id).map((m) => m.id),
        );
        set({
          model: {
            ...model,
            nodes: model.nodes.filter((n) => n.id !== id),
            members: model.members.filter((m) => m.a !== id && m.b !== id),
            supports: model.supports.filter((s) => s.node !== id),
            loads: { ...model.loads, points: model.loads.points.filter((p) => p.node !== id) },
            deck: (model.deck ?? []).filter((memberId) => !removedMembers.has(memberId)),
          },
          selection: { kind: 'none' },
          notice: `Deleted node ${id}`,
        });
      } else if (selection.kind === 'member' || selection.kind === 'members') {
        const ids = new Set(selection.kind === 'member' ? [selection.id] : selection.ids);
        set({
          model: {
            ...model,
            members: model.members.filter((m) => !ids.has(m.id)),
            deck: (model.deck ?? []).filter((memberId) => !ids.has(memberId)),
          },
          selection: { kind: 'none' },
          notice: `Deleted ${ids.size} member${ids.size === 1 ? '' : 's'}`,
        });
      }
    },

    extrude: (customOffset) => {
      const { model, workplane, extrudeDistance, extrudeCount } = get();
      if (model.nodes.length === 0) {
        set({ notice: 'Nothing to extrude — place nodes first.' });
        return;
      }
      const offset =
        customOffset ??
        scaleVec(frameExtrudeAxis(resolveWorkplaneFrame(workplane)), extrudeDistance);
      const result = extrudeModel3d(model, {
        offset,
        count: extrudeCount,
        allocId: () => nextId++,
      });
      if (result.addedNodes === 0) {
        set({ notice: 'Extrude added nothing — check distance.' });
        return;
      }
      if (result.model.members.length > MEMBER_HARD_LIMIT_3D) {
        rawSet({
          notice: `Extrude would exceed the member limit (${MEMBER_HARD_LIMIT_3D}). Simplify before extruding.`,
        });
        return;
      }
      set({
        model: result.model,
        selection: { kind: 'none' },
        notice: `Extruded ${result.addedNodes} nodes / ${result.addedMembers} members (${extrudeCount}× along workplane normal).`,
      });
    },

    replicate: (customOffset) => {
      const { model, workplane, extrudeDistance, extrudeCount } = get();
      if (model.nodes.length === 0) {
        set({ notice: 'Nothing to replicate — place nodes first.' });
        return;
      }
      const offset =
        customOffset ??
        scaleVec(frameExtrudeAxis(resolveWorkplaneFrame(workplane)), extrudeDistance);
      const result = replicateModel3d(model, {
        offset,
        count: extrudeCount,
        allocId: () => nextId++,
      });
      if (result.addedNodes === 0) {
        set({ notice: 'Replicate added nothing — check distance.' });
        return;
      }
      if (result.model.members.length > MEMBER_HARD_LIMIT_3D) {
        rawSet({
          notice: `Replicate would exceed the member limit (${MEMBER_HARD_LIMIT_3D}). Simplify before replicating.`,
        });
        return;
      }
      set({
        model: result.model,
        selection: { kind: 'none' },
        notice: `Replicated ${result.addedNodes} nodes / ${result.addedMembers} members (${extrudeCount}×, no struts).`,
      });
    },

    setWindDirectionDeg: (directionDeg) => {
      const deg = ((directionDeg % 360) + 360) % 360;
      get().setWindStory({ directionDeg: deg });
    },

    setWindStory: (partial) => {
      const { model } = get();
      const defaults: Extract<StorySpec3d, { kind: 'wind' }> = {
        kind: 'wind',
        pattern: 'sine',
        amplitudekNm: 3,
        freqHz: 0.5,
        zeta: 0.02,
        directionDeg: 0,
      };
      const current = model.story?.kind === 'wind' ? model.story : defaults;
      const story = { ...current, ...partial, kind: 'wind' as const };
      set({
        model: { ...model, story },
        notice: `Wind ${story.pattern} · ${story.directionDeg.toFixed(0)}° from +X · ${story.amplitudekNm} kN/m · ${story.freqHz} Hz`,
      });
    },

    setTrafficStory: (partial = {}) => {
      const { model } = get();
      const defaults: Extract<StorySpec3d, { kind: 'traffic' }> = {
        kind: 'traffic',
        weightkN: 250,
        speed: 12,
        movingMass: false,
      };
      const current = model.story?.kind === 'traffic' ? model.story : defaults;
      const story = { ...current, ...partial, kind: 'traffic' as const };
      set({
        model: { ...model, story },
        notice: `Traffic · ${story.weightkN} kN · ${story.speed} m/s${story.movingMass ? ' · moving mass' : ''} — paint a contiguous deck path`,
      });
    },

    setRampStory: () => {
      const { model } = get();
      set({
        model: { ...model, story: { kind: 'ramp' } },
        notice: 'Load ramp — proportional factor on reference loads to first limit.',
      });
    },

    setPushoverStory: () => {
      const { model } = get();
      set({
        model: { ...model, story: { kind: 'pushover' } },
        notice: 'Plastic pushover — hinges when |M| reaches M_p.',
      });
    },

    setEarthquakeStory: (partial = {}) => {
      const { model } = get();
      const defaults: Extract<StorySpec3d, { kind: 'earthquake' }> = {
        kind: 'earthquake',
        record: 'pulse',
        scale: 1,
        zeta: 0.05,
      };
      const current = model.story?.kind === 'earthquake' ? model.story : defaults;
      const story = { ...current, ...partial, kind: 'earthquake' as const };
      set({
        model: { ...model, story },
        notice: `Earthquake · ${story.record} · scale ${story.scale} · ζ ${(story.zeta * 100).toFixed(0)}%`,
      });
    },

    toggleDeckMember: (memberId) => {
      const { model } = get();
      const deck = [...(model.deck ?? [])];
      const index = deck.indexOf(memberId);
      if (index >= 0) {
        if (index !== 0 && index !== deck.length - 1) {
          set({ notice: 'Remove deck members from either end to keep the path contiguous.' });
          return;
        }
        deck.splice(index, 1);
        set({
          model: { ...model, deck },
          selection: { kind: 'member', id: memberId },
          notice: `Deck path: ${deck.length} member${deck.length === 1 ? '' : 's'}`,
        });
        return;
      }
      const candidate = model.members.find((m) => m.id === memberId);
      if (!candidate) return;
      if (deck.length === 0) {
        set({
          model: {
            ...model,
            deck: [memberId],
            story:
              model.story?.kind === 'traffic'
                ? model.story
                : { kind: 'traffic', weightkN: 250, speed: 12, movingMass: false },
          },
          selection: { kind: 'member', id: memberId },
          notice: 'Deck path started — extend from either end.',
        });
        return;
      }
      const first = model.members.find((m) => m.id === deck[0]!);
      const last = model.members.find((m) => m.id === deck[deck.length - 1]!);
      if (!first || !last) return;
      const shares = (a: { a: number; b: number }, b: { a: number; b: number }) =>
        a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
      if (shares(candidate, last)) {
        set({
          model: { ...model, deck: [...deck, memberId] },
          selection: { kind: 'member', id: memberId },
          notice: `Deck path: ${deck.length + 1} members`,
        });
        return;
      }
      if (shares(candidate, first)) {
        set({
          model: { ...model, deck: [memberId, ...deck] },
          selection: { kind: 'member', id: memberId },
          notice: `Deck path: ${deck.length + 1} members`,
        });
        return;
      }
      set({ notice: 'Deck members must form one contiguous path.' });
    },
  };
});
