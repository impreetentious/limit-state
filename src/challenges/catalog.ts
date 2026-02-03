/**
 * Four constrained-budget challenges.
 * Starters place abutments (or a mast base) and leave the structure for the visitor.
 */
import type { EditorModel, MemberSpec, SectionSpec } from '../fem/types';
import type { ChallengeSpec } from './types';

const DEEP_IBEAM: SectionSpec = { kind: 'ibeam', b: 0.24, h: 0.68, tf: 0.022, tw: 0.012 };
const MAST_TUBE: SectionSpec = { kind: 'tube', d: 0.26, t: 0.012 };
const TRUSS_CHORD: SectionSpec = { kind: 'rect', b: 0.04, h: 0.04 };

/** Authored challenge catalog — load a starter, then satisfy the budget. */
export const CHALLENGES: ChallengeSpec[] = [
  {
    id: 'span-40-steel-6t',
    label: '1 · Span 40 m under 6 t',
    brief: 'Clear 40 m on abutments only, under 6 t of steel, and carry a 100 kN truck at midspan.',
    constraints: {
      minClearSpanM: 40,
      maxSteelMassKg: 6000,
      minTruckCapacitykN: 100,
      abutmentsOnly: true,
    },
    starter: abutments('Challenge: Span 40 m', 40, 100),
  },
  {
    id: 'heavy-12m',
    label: '2 · Heavy truck, 12 m',
    brief: 'Clear 12 m under 3 t of steel and carry a 400 kN truck — short span, hard load.',
    constraints: {
      minClearSpanM: 12,
      maxSteelMassKg: 3000,
      minTruckCapacitykN: 400,
      abutmentsOnly: true,
    },
    starter: abutments('Challenge: Heavy 12 m', 12, 400),
  },
  {
    id: 'mast-30-lambda-2',
    label: '3 · 30 m mast, λ ≥ 2',
    brief: 'Reach 30 m height under 2.5 t of steel; a 2 kN tip lateral load must keep ramp λ ≥ 2.',
    constraints: {
      minHeightM: 30,
      maxSteelMassKg: 2500,
      minRampLambda: 2,
      probeTipLoadN: 2_000,
    },
    starter: {
      v: 1,
      name: 'Challenge: 30 m mast',
      seed: 42,
      nodes: [node(1, 0, 0)],
      members: [],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [] },
      deck: [],
      story: { kind: 'ramp' },
    },
  },
  {
    id: 'efficient-24m',
    label: '4 · Efficient 24 m',
    brief: 'Clear 24 m under 2 t of steel and carry 80 kN — capacity per kilogram is the point.',
    constraints: {
      minClearSpanM: 24,
      maxSteelMassKg: 2000,
      minTruckCapacitykN: 80,
      abutmentsOnly: true,
    },
    starter: abutments('Challenge: Efficient 24 m', 24, 80),
  },
];

/** Reference solutions used by the gallery and by G20. */
export const CHALLENGE_SOLUTIONS: Record<string, EditorModel> = {
  'span-40-steel-6t': deepBeamSolution('Solution: Span 40 m', 40, 100, DEEP_IBEAM),
  'heavy-12m': deepBeamSolution('Solution: Heavy 12 m', 12, 400, {
    kind: 'ibeam',
    b: 0.3,
    h: 0.9,
    tf: 0.03,
    tw: 0.016,
  }),
  'mast-30-lambda-2': mastSolution(),
  'efficient-24m': prattSolution(),
};

export function challengeById(id: string): ChallengeSpec | undefined {
  return CHALLENGES.find((challenge) => challenge.id === id);
}

function abutments(name: string, spanM: number, weightkN: number): EditorModel {
  const half = spanM / 2;
  return {
    v: 1,
    name,
    seed: 42,
    nodes: [node(1, -half, 0), node(2, half, 0)],
    members: [],
    supports: [
      { node: 1, kind: 'pin' },
      { node: 2, kind: 'roller' },
    ],
    loads: { gravity: true, points: [] },
    deck: [],
    story: { kind: 'traffic', weightkN, speed: 12, movingMass: false },
  };
}

function deepBeamSolution(
  name: string,
  spanM: number,
  weightkN: number,
  section: SectionSpec,
): EditorModel {
  const half = spanM / 2;
  return {
    v: 1,
    name,
    seed: 42,
    nodes: [node(1, -half, 0), node(2, 0, 0), node(3, half, 0)],
    members: [frame(1, 1, 2, section), frame(2, 2, 3, section)],
    supports: [
      { node: 1, kind: 'pin' },
      { node: 3, kind: 'roller' },
    ],
    loads: { gravity: true, points: [] },
    deck: [1, 2],
    story: { kind: 'traffic', weightkN, speed: 12, movingMass: false },
  };
}

function mastSolution(): EditorModel {
  return {
    v: 1,
    name: 'Solution: 30 m mast',
    seed: 42,
    nodes: [node(1, 0, 0), node(2, 0, 15), node(3, 0, 30)],
    members: [frame(1, 1, 2, MAST_TUBE), frame(2, 2, 3, MAST_TUBE)],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [{ node: 3, fx: 2_000, fy: 0 }] },
    deck: [],
    story: { kind: 'ramp' },
  };
}

/** Light Pratt-style truss for the efficiency challenge. */
function prattSolution(): EditorModel {
  const section = TRUSS_CHORD;
  return {
    v: 1,
    name: 'Solution: Efficient 24 m',
    seed: 42,
    nodes: [
      node(1, -12, 0),
      node(2, -4, 0),
      node(3, 4, 0),
      node(4, 12, 0),
      node(5, -8, 4),
      node(6, 0, 4),
      node(7, 8, 4),
    ],
    members: [
      truss(1, 1, 2, section),
      truss(2, 2, 3, section),
      truss(3, 3, 4, section),
      truss(4, 1, 5, section),
      truss(5, 5, 6, section),
      truss(6, 6, 7, section),
      truss(7, 7, 4, section),
      truss(8, 5, 2, section),
      truss(9, 2, 6, section),
      truss(10, 6, 3, section),
      truss(11, 3, 7, section),
    ],
    supports: [
      { node: 1, kind: 'pin' },
      { node: 4, kind: 'roller' },
    ],
    loads: { gravity: true, points: [] },
    deck: [1, 2, 3],
    story: { kind: 'traffic', weightkN: 80, speed: 12, movingMass: false },
  };
}

function node(id: number, x: number, y: number): EditorModel['nodes'][number] {
  return { id, x, y };
}

function frame(id: number, a: number, b: number, section: SectionSpec): MemberSpec {
  return {
    id,
    a,
    b,
    material: 'steel-s355',
    section: { ...section },
    releaseA: false,
    releaseB: false,
    cableOnly: false,
  };
}

function truss(id: number, a: number, b: number, section: SectionSpec): MemberSpec {
  return { ...frame(id, a, b, section), releaseA: true, releaseB: true };
}
