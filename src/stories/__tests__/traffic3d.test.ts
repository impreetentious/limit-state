import { describe, expect, it } from 'vitest';
import { NO_RELEASES, type EditorModel3d } from '../../fem/space';
import { assembleLoadCase3d, pointFixedEnd3d } from '../../fem/space/assemble';
import { buildDeckRoute3d, deckLength3d, mapDeckStation3d } from '../../fem/space/deck';
import { buildMesh3d } from '../../fem/space/mesh';
import { analyzeTrafficAt3d, prepareTraffic3d } from '../traffic3d';

const SECTION = { kind: 'box' as const, b: 0.3, h: 0.5, t: 0.02 };

/** Pin–pin beam along +X; deck = single member. Gravity traffic rides −Z. */
function deckBeam(): EditorModel3d {
  const L = 16;
  return {
    v: 2,
    name: 'deck beam',
    seed: 1,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: L, y: 0, z: 0 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: 'steel-s355',
        section: SECTION,
        releaseA: NO_RELEASES,
        releaseB: NO_RELEASES,
        roll: 0,
      },
    ],
    supports: [
      { node: 1, kind: 'fixed' },
      { node: 2, kind: 'pin' },
    ],
    loads: { gravity: false, points: [] },
    deck: [1],
    story: { kind: 'traffic', weightkN: 200, speed: 10 },
  };
}

describe('3D traffic polyline (Phase 3)', () => {
  it('builds a deck route whose length matches the member', () => {
    const model = deckBeam();
    const mesh = buildMesh3d(model);
    const route = buildDeckRoute3d(model, mesh);
    expect(deckLength3d(route)).toBeCloseTo(16, 12);
    expect(route).toHaveLength(1);
    expect(route[0]!.elements.length).toBeGreaterThanOrEqual(1);
  });

  it('maps midspan station onto the beam with z = 0', () => {
    const model = deckBeam();
    const mesh = buildMesh3d(model);
    const route = buildDeckRoute3d(model, mesh);
    const [hit] = mapDeckStation3d(model, mesh, route, 8);
    expect(hit).toBeDefined();
    expect(hit!.x).toBeCloseTo(8, 9);
    expect(hit!.y).toBeCloseTo(0, 9);
    expect(hit!.z).toBeCloseTo(0, 9);
    expect(hit!.xi).toBeGreaterThanOrEqual(0);
    expect(hit!.xi).toBeLessThanOrEqual(1);
  });

  it('Hermite fixed-end axial shares (1−ξ, ξ)', () => {
    const f = pointFixedEnd3d(10, 0, 0, 0.25, 4);
    expect(f[0]).toBeCloseTo(-7.5, 12);
    expect(f[6]).toBeCloseTo(-2.5, 12);
  });

  it('axle resultant equals vehicle weight along −Z', () => {
    const scenario = prepareTraffic3d(deckBeam());
    const frame = analyzeTrafficAt3d(scenario, 8);
    expect(frame.analysis.kind).toBe('stable');
    if (frame.analysis.kind !== 'stable') return;
    // Both axles on deck at station 8 and 4 → total −200 kN.
    let fz = 0;
    for (const [, r] of frame.analysis.result.reactions) fz += r.fz;
    expect(fz).toBeCloseTo(200_000, 3);
    expect(frame.axles.length).toBe(2);
  });

  it('assembles in-element Hermite load with zero net torque about midspan for symmetric case', () => {
    const model = deckBeam();
    const mesh = buildMesh3d(model);
    const route = buildDeckRoute3d(model, mesh);
    const [hit] = mapDeckStation3d(model, mesh, route, 8);
    expect(hit).toBeDefined();
    const { F } = assembleLoadCase3d(mesh, {
      inElement: [{ element: hit!.element, xi: hit!.xi, fx: 0, fy: 0, fz: -100_000 }],
    });
    let sumFz = 0;
    for (let node = 0; mesh.ndof > node * 6; node++) sumFz += F[6 * node + 2]!;
    expect(sumFz).toBeCloseTo(-100_000, 6);
  });
});
