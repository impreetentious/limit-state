import { create } from 'zustand';
import { DEFAULT_SECTION } from '../fem/materials';
import type { EditorModel, MemberSpec, PointLoad, SectionSpec, SupportKind } from '../fem/types';

export type EditorTool = 'select' | 'node' | 'member' | 'support' | 'load' | 'deck' | 'delete';
export type AppMode = 'build' | 'test';
export type ResultDiagram = 'none' | 'axial' | 'shear' | 'moment';

export type Selection =
  | { kind: 'none' }
  | { kind: 'node'; id: number }
  | { kind: 'member'; id: number };

export type Stability =
  | { kind: 'idle'; message: string }
  | { kind: 'checking'; message: string }
  | { kind: 'stable'; message: string }
  | { kind: 'mechanism'; nodeId: number; message: string }
  | { kind: 'invalid'; message: string };

export interface EditorStore {
  model: EditorModel;
  mode: AppMode;
  tool: EditorTool;
  selection: Selection;
  gridSnap: boolean;
  past: EditorModel[];
  future: EditorModel[];
  stability: Stability;
  notice: string | null;
  resultDiagram: ResultDiagram;
  showDeformed: boolean;
  setMode: (mode: AppMode) => void;
  setTool: (tool: EditorTool) => void;
  select: (selection: Selection) => void;
  setGridSnap: (enabled: boolean) => void;
  setModelName: (name: string) => void;
  addNode: (x: number, y: number) => number;
  updateNode: (id: number, x: number, y: number) => void;
  addMember: (a: number, b: number) => number | undefined;
  updateMember: (id: number, patch: Partial<Omit<MemberSpec, 'id' | 'a' | 'b'>>) => void;
  setSupport: (node: number, kind: SupportKind | undefined) => void;
  cycleSupport: (node: number) => void;
  setPointLoad: (node: number, fx: number, fy: number) => void;
  toggleDeckMember: (memberId: number) => void;
  deleteNode: (id: number) => void;
  deleteMember: (id: number) => void;
  setStability: (stability: Stability) => void;
  setNotice: (notice: string | null) => void;
  setResultDiagram: (diagram: ResultDiagram) => void;
  setShowDeformed: (show: boolean) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
}

const HISTORY_LIMIT = 100;

/** Blank grid preset. */
export function createBlankModel(): EditorModel {
  return {
    v: 1,
    name: 'Untitled structure',
    seed: 42,
    nodes: [],
    members: [],
    supports: [],
    loads: { gravity: true, points: [] },
    deck: [],
    story: { kind: 'traffic', weightkN: 300, speed: 12 },
  };
}

/** Snapshot clone for the small, serializable editor model. */
export function cloneModel(model: EditorModel): EditorModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => ({ ...node })),
    members: model.members.map((member) => ({ ...member, section: { ...member.section } })),
    supports: model.supports.map((support) => ({ ...support })),
    loads: { ...model.loads, points: model.loads.points.map((point) => ({ ...point })) },
    deck: [...model.deck],
    story: { ...model.story },
  };
}

export const useEditorStore = create<EditorStore>((set) => ({
  model: createBlankModel(),
  mode: 'build',
  tool: 'select',
  selection: { kind: 'none' },
  gridSnap: true,
  past: [],
  future: [],
  stability: { kind: 'idle', message: 'Draw a member to begin.' },
  notice: null,
  resultDiagram: 'none',
  showDeformed: true,
  setMode: (mode) => set({ mode }),
  setTool: (tool) => set({ tool, notice: null }),
  select: (selection) => set({ selection }),
  setGridSnap: (gridSnap) => set({ gridSnap }),
  setModelName: (name) => mutate(set, (model) => ({ ...model, name })),
  addNode: (x, y) => {
    let id = 0;
    mutate(set, (model) => {
      id = nextId(model.nodes);
      return { ...model, nodes: [...model.nodes, { id, x, y }] };
    }, () => ({ kind: 'node', id }));
    return id;
  },
  updateNode: (id, x, y) => mutate(set, (model) => ({
    ...model,
    nodes: model.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)),
  })),
  addMember: (a, b) => {
    let id: number | undefined;
    mutate(set, (model) => {
      if (a === b) return model;
      if (!model.nodes.some((node) => node.id === a) || !model.nodes.some((node) => node.id === b)) return model;
      if (model.members.some((member) => (member.a === a && member.b === b) || (member.a === b && member.b === a))) {
        return model;
      }
      id = nextId(model.members);
      return {
        ...model,
        members: [
          ...model.members,
          {
            id,
            a,
            b,
            material: 'steel-s355',
            section: { ...DEFAULT_SECTION },
            releaseA: false,
            releaseB: false,
          },
        ],
      };
    }, () => (id === undefined ? undefined : { kind: 'member', id }));
    return id;
  },
  updateMember: (id, patch) => mutate(set, (model) => ({
    ...model,
    members: model.members.map((member) => (member.id === id ? { ...member, ...patch } : member)),
  })),
  setSupport: (node, kind) => mutate(set, (model) => ({
    ...model,
    supports: kind === undefined
      ? model.supports.filter((support) => support.node !== node)
      : [...model.supports.filter((support) => support.node !== node), { node, kind }],
  })),
  cycleSupport: (node) => {
    const current = useEditorStore.getState().model.supports.find((support) => support.node === node)?.kind;
    const next: SupportKind | undefined =
      current === undefined ? 'pin' : current === 'pin' ? 'roller' : current === 'roller' ? 'fixed' : undefined;
    useEditorStore.getState().setSupport(node, next);
  },
  setPointLoad: (node, fx, fy) => mutate(set, (model) => {
    const points = model.loads.points.filter((point) => point.node !== node);
    const point: PointLoad = { node, fx, fy };
    return { ...model, loads: { ...model.loads, points: [...points, point] } };
  }),
  toggleDeckMember: (memberId) => {
    let notice: string | null = null;
    mutate(set, (model) => {
      const index = model.deck.indexOf(memberId);
      if (index >= 0) {
        if (index !== 0 && index !== model.deck.length - 1) {
          notice = 'Remove deck members from either end to keep the path contiguous.';
          return model;
        }
        return { ...model, deck: model.deck.filter((id) => id !== memberId) };
      }
      const candidate = model.members.find((member) => member.id === memberId);
      if (!candidate) return model;
      if (model.deck.length === 0) return { ...model, deck: [memberId] };
      const first = model.members.find((member) => member.id === model.deck[0]!);
      const last = model.members.find((member) => member.id === model.deck[model.deck.length - 1]!);
      if (!first || !last) return model;
      if (sharesNode(candidate, last)) return { ...model, deck: [...model.deck, memberId] };
      if (sharesNode(candidate, first)) return { ...model, deck: [memberId, ...model.deck] };
      notice = 'Deck members must form one contiguous path.';
      return model;
    });
    if (notice) set({ notice });
  },
  deleteNode: (id) => mutate(set, (model) => {
    const removedMembers = new Set(model.members.filter((member) => member.a === id || member.b === id).map((member) => member.id));
    return {
      ...model,
      nodes: model.nodes.filter((node) => node.id !== id),
      members: model.members.filter((member) => !removedMembers.has(member.id)),
      supports: model.supports.filter((support) => support.node !== id),
      loads: { ...model.loads, points: model.loads.points.filter((point) => point.node !== id) },
      deck: model.deck.filter((memberId) => !removedMembers.has(memberId)),
    };
  }, () => ({ kind: 'none' })),
  deleteMember: (id) => mutate(set, (model) => ({
    ...model,
    members: model.members.filter((member) => member.id !== id),
    deck: model.deck.filter((memberId) => memberId !== id),
  }), () => ({ kind: 'none' })),
  setStability: (stability) => set({ stability }),
  setNotice: (notice) => set({ notice }),
  setResultDiagram: (resultDiagram) => set({ resultDiagram }),
  setShowDeformed: (showDeformed) => set({ showDeformed }),
  undo: () => set((state) => {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      model: cloneModel(previous),
      past: state.past.slice(0, -1),
      future: [cloneModel(state.model), ...state.future],
      selection: { kind: 'none' },
      notice: null,
    };
  }),
  redo: () => set((state) => {
    const next = state.future[0];
    if (!next) return state;
    return {
      model: cloneModel(next),
      past: [...state.past, cloneModel(state.model)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      selection: { kind: 'none' },
      notice: null,
    };
  }),
  reset: () => set({
    model: createBlankModel(),
    selection: { kind: 'none' },
    past: [],
    future: [],
    stability: { kind: 'idle', message: 'Draw a member to begin.' },
    notice: null,
  }),
}));

function mutate(
  set: (partial: Partial<EditorStore> | ((state: EditorStore) => Partial<EditorStore>)) => void,
  update: (model: EditorModel) => EditorModel,
  selection?: () => Selection | undefined,
): void {
  set((state) => {
    const current = cloneModel(state.model);
    const next = update(current);
    if (next === current) return {};
    return {
      model: next,
      past: [...state.past, cloneModel(state.model)].slice(-HISTORY_LIMIT),
      future: [],
      selection: selection?.() ?? state.selection,
      notice: null,
    };
  });
}

function nextId(items: ReadonlyArray<{ id: number }>): number {
  return items.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1;
}

function sharesNode(a: MemberSpec, b: MemberSpec): boolean {
  return a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
}

export function defaultSection(kind: SectionSpec['kind']): SectionSpec {
  switch (kind) {
    case 'rect': return { kind, b: 0.2, h: 0.3 };
    case 'box': return { kind, b: 0.2, h: 0.2, t: 0.008 };
    case 'ibeam': return { kind, b: 0.2, h: 0.3, tf: 0.02, tw: 0.012 };
    case 'tube': return { kind, d: 0.2, t: 0.01 };
  }
}
