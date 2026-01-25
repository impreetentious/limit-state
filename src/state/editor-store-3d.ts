/**
 * Phase 3 workplane editor store — ground / elevation draw into EditorModel3d.
 * Schema v2 only; 2D store stays untouched.
 */
import { create } from 'zustand';
import { DEFAULT_SECTION } from '../fem/materials';
import {
  NO_RELEASES,
  type EditorModel3d,
  type SupportKind3d,
} from '../fem/space';
import { spacePortalDemo } from '../presets/scenes3d';

export type Workplane = 'ground' | 'xz' | 'yz';
export type EditorTool3d = 'select' | 'node' | 'member' | 'support' | 'load' | 'delete';

export type Selection3d =
  | { kind: 'none' }
  | { kind: 'node'; id: number }
  | { kind: 'member'; id: number };

interface EditorState3d {
  model: EditorModel3d;
  tool: EditorTool3d;
  workplane: Workplane;
  gridSnap: boolean;
  selection: Selection3d;
  memberStart: number | null;
  notice: string | null;
  setTool: (tool: EditorTool3d) => void;
  setWorkplane: (plane: Workplane) => void;
  setGridSnap: (snap: boolean) => void;
  setSelection: (selection: Selection3d) => void;
  setNotice: (notice: string | null) => void;
  loadModel: (model: EditorModel3d) => void;
  reset: () => void;
  addNodeAt: (x: number, y: number, z: number) => number;
  addMemberBetween: (a: number, b: number) => void;
  setSupportOnNode: (nodeId: number, kind?: SupportKind3d) => void;
  addLoadOnNode: (nodeId: number) => void;
  deleteSelection: () => void;
  setMemberStart: (id: number | null) => void;
  setModelName: (name: string) => void;
}

const blankModel = (): EditorModel3d => ({
  v: 2,
  name: 'Blank space',
  seed: 1,
  nodes: [],
  members: [],
  supports: [],
  loads: { gravity: false, points: [] },
});

function snapValue(value: number, enabled: boolean): number {
  return enabled ? Math.round(value * 2) / 2 : value;
}

let nextId = 100;

export const useEditorStore3d = create<EditorState3d>((set, get) => ({
  model: spacePortalDemo(),
  tool: 'select',
  workplane: 'ground',
  gridSnap: true,
  selection: { kind: 'none' },
  memberStart: null,
  notice: null,

  setTool: (tool) => set({ tool, memberStart: null }),
  setWorkplane: (workplane) => set({ workplane }),
  setGridSnap: (gridSnap) => set({ gridSnap }),
  setSelection: (selection) => set({ selection }),
  setNotice: (notice) => set({ notice }),
  setMemberStart: (memberStart) => set({ memberStart }),
  setModelName: (name) => set((state) => ({ model: { ...state.model, name } })),

  loadModel: (model) => {
    nextId = Math.max(nextId, ...model.nodes.map((n) => n.id), ...model.members.map((m) => m.id), 100) + 1;
    set({ model, selection: { kind: 'none' }, memberStart: null, notice: null });
  },

  reset: () => set({ model: blankModel(), selection: { kind: 'none' }, memberStart: null, notice: 'Blank space — draw on the ground workplane.' }),

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
    const nextKind = kind ?? (existing ? order[(order.indexOf(existing.kind) + 1) % order.length]! : 'pin');
    const supports = model.supports.filter((s) => s.node !== nodeId);
    supports.push({ node: nodeId, kind: nextKind });
    set({ model: { ...model, supports }, selection: { kind: 'node', id: nodeId }, notice: `Support ${nextKind} on node ${nodeId}` });
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
      set({
        model: {
          ...model,
          nodes: model.nodes.filter((n) => n.id !== id),
          members: model.members.filter((m) => m.a !== id && m.b !== id),
          supports: model.supports.filter((s) => s.node !== id),
          loads: { ...model.loads, points: model.loads.points.filter((p) => p.node !== id) },
        },
        selection: { kind: 'none' },
        notice: `Deleted node ${id}`,
      });
    } else if (selection.kind === 'member') {
      set({
        model: { ...model, members: model.members.filter((m) => m.id !== selection.id) },
        selection: { kind: 'none' },
        notice: `Deleted member ${selection.id}`,
      });
    }
  },
}));

/** Project a world hit onto the active workplane (Z-up). */
export function projectToWorkplane(
  point: { x: number; y: number; z: number },
  plane: Workplane,
): { x: number; y: number; z: number } {
  switch (plane) {
    case 'ground':
      return { x: point.x, y: point.y, z: 0 };
    case 'xz':
      return { x: point.x, y: 0, z: point.z };
    case 'yz':
      return { x: 0, y: point.y, z: point.z };
  }
}
