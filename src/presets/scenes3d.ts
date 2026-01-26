/**
 * Phase 3 teaching presets — spatial rebuilds of §7 scenes.
 * Slender deck is a twin-girder ladder so modal f₂ is St. Venant torsion
 * (the Tacoma cousin). Warping / aeroelastic flutter remain out of scope.
 */
import { NO_RELEASES, type EditorModel3d, type EndReleases3d, type MemberSpec3d, type NodeSpec3d, type SupportSpec3d } from '../fem/space';
import type { MaterialId, SectionSpec } from '../fem/types';

const STEEL: MaterialId = 'steel-s355';
const BOX: SectionSpec = { kind: 'box', b: 0.2, h: 0.2, t: 0.008 };
const TRUSS_BAR: SectionSpec = { kind: 'rect', b: 0.08, h: 0.08 };
const SLENDER_MAST: SectionSpec = { kind: 'rect', b: 0.12, h: 0.32 };
const GIRDER: SectionSpec = { kind: 'ibeam', b: 0.25, h: 0.8, tf: 0.02, tw: 0.012 };
const CROSS_BEAM: SectionSpec = { kind: 'rect', b: 0.1, h: 0.25 };

export interface PresetScene3d {
  id: string;
  label: string;
  build: () => EditorModel3d;
}

function frame(
  id: number,
  a: number,
  b: number,
  section: SectionSpec = BOX,
  material: MaterialId = STEEL,
): MemberSpec3d {
  return { id, a, b, material, section: { ...section }, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 };
}

function truss(id: number, a: number, b: number, section: SectionSpec = TRUSS_BAR): MemberSpec3d {
  // Release bending (θy, θz); keep torsion so condensation stays nonsingular on open sections.
  const bendingOnly: EndReleases3d = { tx: false, ty: true, tz: true };
  return { id, a, b, material: STEEL, section: { ...section }, releaseA: bendingOnly, releaseB: bendingOnly, roll: 0 };
}

/** Fixed-base space portal: two columns + beam, lateral tip load. */
export function spacePortalDemo(): EditorModel3d {
  const H = 6;
  const B = 8;
  return {
    v: 2,
    name: 'Space portal',
    seed: 3,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: B, y: 0, z: 0 },
      { id: 3, x: 0, y: 0, z: H },
      { id: 4, x: B, y: 0, z: H },
    ],
    members: [frame(1, 1, 3), frame(2, 2, 4), frame(3, 3, 4)],
    supports: [
      { node: 1, kind: 'fixed' },
      { node: 2, kind: 'fixed' },
    ],
    loads: {
      gravity: false,
      points: [{ node: 3, fx: 0, fy: -80e3, fz: 0 }],
    },
    story: {
      kind: 'wind',
      pattern: 'sine',
      amplitudekNm: 4,
      freqHz: 0.8,
      zeta: 0.02,
      directionDeg: 90,
    },
  };
}

/** Slender free-standing mast — lateral wind resonance. */
export function slenderMastDemo(): EditorModel3d {
  const H = 24;
  const n = 4;
  const nodes: NodeSpec3d[] = [{ id: 1, x: 0, y: 0, z: 0 }];
  const members: MemberSpec3d[] = [];
  for (let i = 1; i <= n; i++) {
    nodes.push({ id: i + 1, x: 0, y: 0, z: (H * i) / n });
    members.push(frame(i, i, i + 1, { kind: 'tube', d: 0.25, t: 0.01 }));
  }
  return {
    v: 2,
    name: 'Slender mast',
    seed: 11,
    nodes,
    members,
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [] },
    story: {
      kind: 'wind',
      pattern: 'sine',
      amplitudekNm: 2.5,
      freqHz: 0.35,
      zeta: 0.02,
      directionDeg: 0,
    },
  };
}

/** Two-bay space frame with plan bracing. */
export function spaceFrameDemo(): EditorModel3d {
  const H = 5;
  const Bx = 6;
  const By = 4;
  return {
    v: 2,
    name: 'Space frame',
    seed: 7,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: Bx, y: 0, z: 0 },
      { id: 3, x: Bx, y: By, z: 0 },
      { id: 4, x: 0, y: By, z: 0 },
      { id: 5, x: 0, y: 0, z: H },
      { id: 6, x: Bx, y: 0, z: H },
      { id: 7, x: Bx, y: By, z: H },
      { id: 8, x: 0, y: By, z: H },
    ],
    members: [
      frame(1, 1, 5),
      frame(2, 2, 6),
      frame(3, 3, 7),
      frame(4, 4, 8),
      frame(5, 5, 6),
      frame(6, 6, 7),
      frame(7, 7, 8),
      frame(8, 8, 5),
      frame(9, 5, 7, TRUSS_BAR),
    ],
    supports: [
      { node: 1, kind: 'fixed' },
      { node: 2, kind: 'fixed' },
      { node: 3, kind: 'fixed' },
      { node: 4, kind: 'fixed' },
    ],
    loads: {
      gravity: true,
      points: [{ node: 6, fx: 40e3, fy: 0, fz: 0 }],
    },
  };
}

/** Elevated single-girder deck for traffic polyline demo. */
export function spaceDeckDemo(): EditorModel3d {
  const H = 5;
  const L = 20;
  return {
    v: 2,
    name: 'Space deck',
    seed: 13,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: L, y: 0, z: 0 },
      { id: 3, x: 0, y: 0, z: H },
      { id: 4, x: L / 2, y: 0, z: H },
      { id: 5, x: L, y: 0, z: H },
    ],
    members: [
      frame(1, 1, 3),
      frame(2, 2, 5),
      frame(3, 3, 4, { kind: 'ibeam', b: 0.25, h: 0.6, tf: 0.02, tw: 0.012 }),
      frame(4, 4, 5, { kind: 'ibeam', b: 0.25, h: 0.6, tf: 0.02, tw: 0.012 }),
    ],
    supports: [
      { node: 1, kind: 'fixed' },
      { node: 2, kind: 'fixed' },
    ],
    loads: { gravity: false, points: [] },
    deck: [3, 4],
    story: { kind: 'traffic', weightkN: 250, speed: 12 },
  };
}

/** Simply-supported beam along +X — diagrams + traffic. */
export function simpleBeam3d(): EditorModel3d {
  const L = 8;
  return {
    v: 2,
    name: 'Simple beam',
    seed: 42,
    nodes: [
      { id: 1, x: -L / 2, y: 0, z: 0 },
      { id: 2, x: L / 2, y: 0, z: 0 },
    ],
    members: [frame(1, 1, 2)],
    supports: [
      { node: 1, kind: 'pin' },
      { node: 2, kind: 'rollerZ' },
    ],
    loads: { gravity: true, points: [] },
    deck: [1],
    story: { kind: 'traffic', weightkN: 300, speed: 12 },
  };
}

/**
 * Spatial Pratt: two parallel planes of the §7 Pratt with transverse ties.
 * Bottom chord of the −Y plane is the traffic deck.
 */
export function prattTruss3d(): EditorModel3d {
  const W = 4;
  const plane = (y: number, idOffset: number): NodeSpec3d[] => [
    { id: idOffset + 1, x: -12, y, z: 0 },
    { id: idOffset + 2, x: -4, y, z: 0 },
    { id: idOffset + 3, x: 4, y, z: 0 },
    { id: idOffset + 4, x: 12, y, z: 0 },
    { id: idOffset + 5, x: -8, y, z: 5 },
    { id: idOffset + 6, x: 0, y, z: 5 },
    { id: idOffset + 7, x: 8, y, z: 5 },
  ];
  const nodes = [...plane(-W / 2, 0), ...plane(W / 2, 7)];
  const members: MemberSpec3d[] = [];
  let mid = 1;
  const addPlane = (o: number) => {
    // Bottom chord, top chord, end posts, diagonals / verticals — same topology as 2D Pratt.
    members.push(truss(mid++, o + 1, o + 2));
    members.push(truss(mid++, o + 2, o + 3));
    members.push(truss(mid++, o + 3, o + 4));
    members.push(truss(mid++, o + 1, o + 5));
    members.push(truss(mid++, o + 5, o + 6));
    members.push(truss(mid++, o + 6, o + 7));
    members.push(truss(mid++, o + 7, o + 4));
    members.push(truss(mid++, o + 5, o + 2));
    members.push(truss(mid++, o + 2, o + 6));
    members.push(truss(mid++, o + 6, o + 3));
    members.push(truss(mid++, o + 3, o + 7));
  };
  addPlane(0);
  addPlane(7);
  // Transverse ties at every corresponding node.
  for (let i = 1; i <= 7; i++) {
    members.push(truss(mid++, i, i + 7, { kind: 'rect', b: 0.06, h: 0.06 }));
  }
  return {
    v: 2,
    name: 'Pratt truss',
    seed: 42,
    nodes,
    members,
    supports: [
      { node: 1, kind: 'pin' },
      { node: 8, kind: 'pin' },
      { node: 4, kind: 'rollerZ' },
      { node: 11, kind: 'rollerZ' },
    ],
    loads: { gravity: true, points: [] },
    deck: [1, 2, 3],
    story: { kind: 'traffic', weightkN: 300, speed: 12 },
  };
}

/** Two-span cantilever bridge — twin girders on fixed piers. */
export function cantileverBridge3d(): EditorModel3d {
  const W = 3;
  const xs = [-12, -4, 4, 12];
  const nodes: NodeSpec3d[] = [];
  let nid = 1;
  const left: number[] = [];
  const right: number[] = [];
  for (const x of xs) {
    left.push(nid);
    nodes.push({ id: nid++, x, y: -W / 2, z: 0 });
    right.push(nid);
    nodes.push({ id: nid++, x, y: W / 2, z: 0 });
  }
  const members: MemberSpec3d[] = [];
  let mid = 1;
  for (let i = 0; i < 3; i++) {
    members.push(frame(mid++, left[i]!, left[i + 1]!));
    members.push(frame(mid++, right[i]!, right[i + 1]!));
  }
  for (let i = 0; i < 4; i++) {
    members.push(frame(mid++, left[i]!, right[i]!, CROSS_BEAM));
  }
  return {
    v: 2,
    name: 'Two-span cantilever',
    seed: 42,
    nodes,
    members,
    supports: [
      { node: left[1]!, kind: 'fixed' },
      { node: right[1]!, kind: 'fixed' },
      { node: left[2]!, kind: 'fixed' },
      { node: right[2]!, kind: 'fixed' },
    ],
    loads: { gravity: true, points: [] },
    deck: [1, 3, 5],
    story: { kind: 'traffic', weightkN: 200, speed: 10 },
  };
}

/** Radio mast — spaghetti column, ramp story. */
export function radioMast3d(): EditorModel3d {
  return {
    v: 2,
    name: 'Radio mast',
    seed: 42,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 0, y: 0, z: 15 },
      { id: 3, x: 0, y: 0, z: 30 },
    ],
    members: [
      frame(1, 1, 2, SLENDER_MAST, 'spaghetti'),
      frame(2, 2, 3, SLENDER_MAST, 'spaghetti'),
    ],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: {
      gravity: false,
      points: [{ node: 3, fx: 5e3, fy: 0, fz: 0 }],
    },
    story: {
      kind: 'wind',
      pattern: 'steady',
      amplitudekNm: 1.5,
      freqHz: 0.5,
      zeta: 0.02,
      directionDeg: 0,
    },
  };
}

/**
 * Twin-girder slender deck — modal f₁ vertical, f₂ St. Venant torsion.
 * Tuned ~60 m × 6 m, 4 spans; open I-girders keep GJ low so torsion appears early.
 * Honesty: this is linear St. Venant torsion, not Tacoma aeroelastic flutter / warping.
 */
export function slenderDeck3d(): EditorModel3d {
  const L = 60;
  const W = 6;
  const n = 4;
  const nodes: NodeSpec3d[] = [];
  const members: MemberSpec3d[] = [];
  let nid = 1;
  let mid = 1;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = -L / 2 + (L * i) / n;
    left.push(nid);
    nodes.push({ id: nid++, x, y: -W / 2, z: 0 });
    right.push(nid);
    nodes.push({ id: nid++, x, y: W / 2, z: 0 });
  }
  const deck: number[] = [];
  for (let i = 0; i < n; i++) {
    const leftId = mid++;
    members.push(frame(leftId, left[i]!, left[i + 1]!, GIRDER));
    deck.push(leftId);
    members.push(frame(mid++, right[i]!, right[i + 1]!, GIRDER));
  }
  for (let i = 0; i <= n; i++) {
    members.push(frame(mid++, left[i]!, right[i]!, CROSS_BEAM));
  }
  return {
    v: 2,
    name: 'Slender deck',
    seed: 42,
    nodes,
    members,
    supports: [
      { node: left[0]!, kind: 'pin' },
      { node: right[0]!, kind: 'pin' },
      { node: left[n]!, kind: 'rollerZ' },
      { node: right[n]!, kind: 'rollerZ' },
    ] satisfies SupportSpec3d[],
    loads: { gravity: false, points: [] },
    deck,
    story: {
      kind: 'wind',
      pattern: 'sine',
      // Near lateral f₃ (~0.41 Hz); open Modal and pick f₂ for the torsional ghost.
      amplitudekNm: 1.5,
      freqHz: 0.4,
      zeta: 0.02,
      directionDeg: 90,
    },
  };
}

export function blankSpace3d(): EditorModel3d {
  return {
    v: 2,
    name: 'Blank space',
    seed: 1,
    nodes: [],
    members: [],
    supports: [],
    loads: { gravity: false, points: [] },
    deck: [],
  };
}

/** Teaching presets menu — spatial cousins of §7, then Phase 3 demos. */
export const PRESETS_3D: PresetScene3d[] = [
  { id: 'simple-beam', label: '1 · Simple beam', build: simpleBeam3d },
  { id: 'pratt-truss', label: '2 · Pratt truss', build: prattTruss3d },
  { id: 'cantilever-bridge', label: '3 · Two-span cantilever', build: cantileverBridge3d },
  { id: 'radio-mast', label: '4 · Radio mast', build: radioMast3d },
  { id: 'slender-deck', label: '5 · Slender deck (torsion)', build: slenderDeck3d },
  { id: 'blank', label: '6 · Blank space', build: blankSpace3d },
  { id: 'portal', label: '7 · Space portal', build: spacePortalDemo },
  { id: 'frame', label: '8 · Space frame', build: spaceFrameDemo },
  { id: 'mast', label: '9 · Slender mast (wind)', build: slenderMastDemo },
  { id: 'deck', label: '10 · Space deck (traffic)', build: spaceDeckDemo },
];

/** @deprecated Prefer PRESETS_3D — kept for existing imports. */
export const DEMOS_3D = PRESETS_3D;
