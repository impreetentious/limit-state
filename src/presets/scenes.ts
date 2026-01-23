/** Authored schema-v1 scenes for the editor menu. */
import type { EditorModel, MemberSpec, SectionSpec } from '../fem/types';

export interface PresetScene {
  id: string;
  label: string;
  model: EditorModel;
}

const BOX: SectionSpec = { kind: 'box', b: 0.2, h: 0.2, t: 0.008 };
const SLENDER: SectionSpec = { kind: 'rect', b: 0.12, h: 0.32 };
// A 60 m steel beam tuned to f₁ ≈ 0.4 Hz for the in-plane resonance lesson.
const RESONANT_DECK: SectionSpec = { kind: 'rect', b: 0.12, h: 0.64 };

export const PRESETS: PresetScene[] = [
  { id: 'simple-beam', label: '1 · Simple beam', model: scene('Simple beam', [node(1, -4, 0), node(2, 4, 0)], [member(1, 1, 2)], [{ node: 1, kind: 'pin' }, { node: 2, kind: 'roller' }], [1]) },
  {
    id: 'pratt-truss',
    label: '2 · Pratt truss',
    model: scene('Pratt truss', [node(1, -12, 0), node(2, -4, 0), node(3, 4, 0), node(4, 12, 0), node(5, -8, 5), node(6, 0, 5), node(7, 8, 5)], [
      truss(1, 1, 2), truss(2, 2, 3), truss(3, 3, 4), truss(4, 1, 5), truss(5, 5, 6), truss(6, 6, 7), truss(7, 7, 4), truss(8, 5, 2), truss(9, 2, 6), truss(10, 6, 3), truss(11, 3, 7),
    ], [{ node: 1, kind: 'pin' }, { node: 4, kind: 'roller' }], [1, 2, 3]),
  },
  {
    id: 'cantilever-bridge',
    label: '3 · Two-span cantilever',
    model: scene('Two-span cantilever bridge', [node(1, -12, 0), node(2, -4, 0), node(3, 4, 0), node(4, 12, 0)], [member(1, 1, 2), member(2, 2, 3), member(3, 3, 4)], [{ node: 2, kind: 'fixed' }, { node: 3, kind: 'fixed' }], [1, 2, 3]),
  },
  {
    id: 'radio-mast',
    label: '4 · Radio mast',
    model: scene('Radio mast', [node(1, 0, 0), node(2, 0, 15), node(3, 0, 30)], [member(1, 1, 2, 'spaghetti', SLENDER), member(2, 2, 3, 'spaghetti', SLENDER)], [{ node: 1, kind: 'fixed' }], [], { kind: 'ramp' }),
  },
  {
    id: 'slender-deck',
    label: '5 · Slender deck',
    model: scene('Slender deck', [node(1, -30, 0), node(2, 0, 0), node(3, 30, 0)], [member(1, 1, 2, 'steel-s355', RESONANT_DECK), member(2, 2, 3, 'steel-s355', RESONANT_DECK)], [{ node: 1, kind: 'pin' }, { node: 3, kind: 'roller' }], [1, 2], { kind: 'wind', pattern: 'sine', amplitudekNm: 2, freqHz: 0.4, zeta: 0.02 }),
  },
  {
    id: 'guyed-mast',
    label: '7 · Guyed mast',
    model: {
      ...scene(
        'Guyed mast',
        [node(1, 0, 0), node(2, 0, 20), node(3, -12, 0), node(4, 12, 0)],
        [
          member(1, 1, 2, 'steel-s355', { kind: 'tube', d: 0.2, t: 0.01 }),
          cable(2, 3, 2, 'steel-s355', { kind: 'rect', b: 0.02, h: 0.02 }),
          cable(3, 4, 2, 'steel-s355', { kind: 'rect', b: 0.02, h: 0.02 }),
        ],
        [{ node: 1, kind: 'fixed' }, { node: 3, kind: 'pin' }, { node: 4, kind: 'pin' }],
        [],
        { kind: 'ramp' },
      ),
      loads: { gravity: false, points: [{ node: 2, fx: 50_000, fy: 0 }] },
    },
  },
  {
    id: 'portal-pushover',
    label: '8 · Portal pushover',
    model: {
      ...scene(
        'Portal frame',
        [node(1, 0, 0), node(2, 8, 0), node(3, 0, 4), node(4, 8, 4)],
        [
          member(1, 1, 3, 'steel-s355', { kind: 'rect', b: 0.2, h: 0.3 }),
          member(2, 2, 4, 'steel-s355', { kind: 'rect', b: 0.2, h: 0.3 }),
          member(3, 3, 4, 'steel-s355', { kind: 'rect', b: 0.2, h: 0.3 }),
        ],
        [{ node: 1, kind: 'fixed' }, { node: 2, kind: 'fixed' }],
        [],
        { kind: 'pushover' },
      ),
      loads: { gravity: false, points: [{ node: 3, fx: 1_000, fy: 0 }] },
    },
  },
  { id: 'blank', label: '6 · Blank grid', model: { v: 1, name: 'Untitled structure', seed: 42, nodes: [], members: [], supports: [], loads: { gravity: true, points: [] }, deck: [], story: { kind: 'traffic', weightkN: 300, speed: 12 } } },
];

function scene(name: string, nodes: EditorModel['nodes'], members: MemberSpec[], supports: EditorModel['supports'], deck: number[], story: EditorModel['story'] = { kind: 'traffic', weightkN: 300, speed: 12 }): EditorModel {
  return { v: 1, name, seed: 42, nodes, members, supports, loads: { gravity: true, points: [] }, deck, story };
}

function node(id: number, x: number, y: number): EditorModel['nodes'][number] {
  return { id, x, y };
}

function member(id: number, a: number, b: number, material: MemberSpec['material'] = 'steel-s355', section: SectionSpec = BOX): MemberSpec {
  return { id, a, b, material, section: { ...section }, releaseA: false, releaseB: false, cableOnly: false };
}

function truss(id: number, a: number, b: number): MemberSpec {
  return { ...member(id, a, b, 'steel-s355', { kind: 'rect', b: 0.08, h: 0.08 }), releaseA: true, releaseB: true, cableOnly: false };
}

function cable(id: number, a: number, b: number, material: MemberSpec['material'] = 'steel-s355', section: SectionSpec = { kind: 'rect', b: 0.02, h: 0.02 }): MemberSpec {
  return { ...member(id, a, b, material, section), releaseA: true, releaseB: true, cableOnly: true };
}
