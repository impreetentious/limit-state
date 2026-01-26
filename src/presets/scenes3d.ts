/**
 * Curated 3D demo scenes for the Phase 3 WebGL viewer (editor lands later).
 * Rendering.
 */
import { NO_RELEASES, type EditorModel3d } from '../fem/space';

const STEEL = 'steel-s355' as const;
const SECTION = { kind: 'box' as const, b: 0.2, h: 0.2, t: 0.008 };

/** Fixed-base space portal: two columns + beam, lateral tip load. */
export function spacePortalDemo(): EditorModel3d {
  const H = 6;
  const B = 8;
  return {
    v: 2,
    name: 'Space portal (3D demo)',
    seed: 3,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: B, y: 0, z: 0 },
      { id: 3, x: 0, y: 0, z: H },
      { id: 4, x: B, y: 0, z: H },
    ],
    members: [
      { id: 1, a: 1, b: 3, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 2, a: 2, b: 4, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 3, a: 3, b: 4, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
    ],
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

/** Slender free-standing mast — lateral wind resonance demo. */
export function slenderMastDemo(): EditorModel3d {
  const H = 24;
  const n = 4;
  const nodes = [{ id: 1, x: 0, y: 0, z: 0 }];
  const members = [];
  for (let i = 1; i <= n; i++) {
    nodes.push({ id: i + 1, x: 0, y: 0, z: (H * i) / n });
    members.push({
      id: i,
      a: i,
      b: i + 1,
      material: STEEL,
      section: { kind: 'tube' as const, d: 0.25, t: 0.01 },
      releaseA: NO_RELEASES,
      releaseB: NO_RELEASES,
      roll: 0,
    });
  }
  return {
    v: 2,
    name: 'Slender mast (wind)',
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

/** Two-bay space frame with out-of-plane bracing — teaches spatial load paths. */
export function spaceFrameDemo(): EditorModel3d {
  const H = 5;
  const Bx = 6;
  const By = 4;
  return {
    v: 2,
    name: 'Space frame (3D demo)',
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
      // Columns
      { id: 1, a: 1, b: 5, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 2, a: 2, b: 6, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 3, a: 3, b: 7, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 4, a: 4, b: 8, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      // Roof beams
      { id: 5, a: 5, b: 6, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 6, a: 6, b: 7, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 7, a: 7, b: 8, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 8, a: 8, b: 5, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      // Plan bracing
      { id: 9, a: 5, b: 7, material: STEEL, section: { kind: 'rect', b: 0.08, h: 0.08 }, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
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

/** Elevated deck on two columns — traffic rides the top chord. */
export function spaceDeckDemo(): EditorModel3d {
  const H = 5;
  const L = 20;
  return {
    v: 2,
    name: 'Space deck (traffic)',
    seed: 13,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: L, y: 0, z: 0 },
      { id: 3, x: 0, y: 0, z: H },
      { id: 4, x: L / 2, y: 0, z: H },
      { id: 5, x: L, y: 0, z: H },
    ],
    members: [
      { id: 1, a: 1, b: 3, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 2, a: 2, b: 5, material: STEEL, section: SECTION, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 3, a: 3, b: 4, material: STEEL, section: { kind: 'ibeam', b: 0.25, h: 0.6, tf: 0.02, tw: 0.012 }, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
      { id: 4, a: 4, b: 5, material: STEEL, section: { kind: 'ibeam', b: 0.25, h: 0.6, tf: 0.02, tw: 0.012 }, releaseA: NO_RELEASES, releaseB: NO_RELEASES, roll: 0 },
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

export const DEMOS_3D = [
  { id: 'portal', label: 'Space portal', build: spacePortalDemo },
  { id: 'frame', label: 'Space frame', build: spaceFrameDemo },
  { id: 'mast', label: 'Slender mast (wind)', build: slenderMastDemo },
  { id: 'deck', label: 'Space deck (traffic)', build: spaceDeckDemo },
] as const;
