import { describe, expect, it } from 'vitest';

import { assembleLoadCase } from '../assemble';
import { elementForcesAtDisplacement, solveStatic } from '../statics';
import type { AnalysisMesh } from '../types';

const L = 8;
const E = 210e9;
const A = 0.01;
const I = 1e-4;
const W = 10_000;
const P = 20_000;

function simpleBeamMesh(): AnalysisMesh {
  return {
    coords: Float64Array.of(0, 0, L, 0),
    elements: [
      {
        memberId: 1,
        na: 0,
        nb: 1,
        E,
        G: E / 2.6,
        A,
        As: (5 / 6) * A,
        I,
        c: Math.sqrt((3 * I) / A),
        rho: 0,
        fy: 355e6,
        L,
        cos: 1,
        sin: 0,
        releaseA: false,
        releaseB: false,
      },
    ],
    editorNode: Int32Array.of(1, 2),
    freeDofs: Int32Array.of(2, 3, 5),
    ndof: 6,
    shearFlexible: false,
  };
}

function recoveredForces(loads: Parameters<typeof assembleLoadCase>[1]) {
  const mesh = simpleBeamMesh();
  const assembled = assembleLoadCase(mesh, loads);
  const analysis = solveStatic(mesh, assembled);
  if (analysis.kind !== 'stable') throw new Error(`Expected stable beam, got ${analysis.kind}`);
  return elementForcesAtDisplacement(mesh, analysis.result.u, assembled.elementFixedEnd);
}

describe('internal-force recovery statics oracles', () => {
  it('recovers exact simply-supported UDL end actions', () => {
    const [n, shearA, momentA, shearB, momentB] = recoveredForces({
      gravity: false,
      points: [],
      elementUdls: [{ element: 0, w: W }],
    });

    expect(n!).toBeCloseTo(0, 8);
    expect(shearA!).toBeCloseTo((W * L) / 2, 8);
    expect(-shearB!).toBeCloseTo(-(W * L) / 2, 8);
    expect(-momentA!).toBeCloseTo(0, 8);
    expect(momentB!).toBeCloseTo(0, 8);
  });

  it('recovers exact simply-supported midspan point-load end actions', () => {
    const [n, shearA, momentA, shearB, momentB] = recoveredForces({
      gravity: false,
      points: [],
      inElement: [{ element: 0, xi: 0.5, p: P }],
    });

    expect(n!).toBeCloseTo(0, 8);
    expect(shearA!).toBeCloseTo(P / 2, 8);
    expect(-shearB!).toBeCloseTo(-P / 2, 8);
    expect(-momentA!).toBeCloseTo(0, 8);
    expect(momentB!).toBeCloseTo(0, 8);
  });
});
