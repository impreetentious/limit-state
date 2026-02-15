/**
 * Phase 3 preset polish — slender deck torsional mode + spatial rebuilds.
 * docs/FEM-SPEC.md §14 Phase 3 Polish / §7.
 */
import { describe, expect, it } from 'vitest';
import { analyzeStaticModel3d, buildMesh3d, modal3d } from '../../fem/space';
import {
  cantileverBridge3d,
  prattTruss3d,
  simpleBeam3d,
  slenderDeck3d,
  slenderMastDemo,
  spaceDeckDemo,
  spacePortalDemo,
} from '../scenes3d';

describe('3D presets (Phase 3 polish)', () => {
  it('builds every teaching preset without a mechanism', () => {
    for (const build of [
      simpleBeam3d,
      prattTruss3d,
      cantileverBridge3d,
      slenderDeck3d,
      slenderMastDemo,
      spacePortalDemo,
      spaceDeckDemo,
    ]) {
      const model = build();
      const mesh = buildMesh3d(model);
      expect(mesh.elements.length).toBeGreaterThan(0);
      expect(mesh.freeDofs.length).toBeGreaterThan(0);
      const analysis = analyzeStaticModel3d(model);
      expect(analysis.kind, model.name).toBe('stable');
    }
  });

  it('slender deck: f₁ vertical heave, f₂ St. Venant torsion (opposite girder uz)', () => {
    const model = slenderDeck3d();
    const mesh = buildMesh3d(model);
    const result = modal3d(mesh, 4);
    expect(result.kind).toBe('modal');

    // Midspan left/right editor nodes: interleaved L,R; n=4 → mid index 2 → ids 5 and 6.
    const leftIdx = model.nodes.findIndex((n) => n.id === 5);
    const rightIdx = model.nodes.findIndex((n) => n.id === 6);
    expect(leftIdx).toBeGreaterThanOrEqual(0);
    expect(rightIdx).toBeGreaterThanOrEqual(0);

    const count = result.values.length;
    const uz = (nodeIndex: number, mode: number) =>
      result.vectors[(nodeIndex * 6 + 2) * count + mode]!;

    const f1 = result.values[0]! / (2 * Math.PI);
    const f2 = result.values[1]! / (2 * Math.PI);
    expect(f1).toBeGreaterThan(0.05);
    expect(f1).toBeLessThan(0.2);
    expect(f2).toBeGreaterThan(0.15);
    expect(f2).toBeLessThan(0.45);
    expect(f2 / f1).toBeGreaterThan(1.5);

    const heave1 = (uz(leftIdx, 0) + uz(rightIdx, 0)) / 2;
    const twist1 = uz(leftIdx, 0) - uz(rightIdx, 0);
    expect(Math.abs(heave1)).toBeGreaterThan(2 * Math.abs(twist1));

    const heave2 = (uz(leftIdx, 1) + uz(rightIdx, 1)) / 2;
    const twist2 = uz(leftIdx, 1) - uz(rightIdx, 1);
    expect(Math.abs(twist2)).toBeGreaterThan(2 * Math.abs(heave2));
    expect(Math.sign(uz(leftIdx, 1))).not.toBe(Math.sign(uz(rightIdx, 1)));
  });

  it('slender deck carries a contiguous deck path on the −Y girder', () => {
    const model = slenderDeck3d();
    expect(model.deck?.length).toBe(4);
    expect(model.story?.kind).toBe('wind');
  });

  it('spatial Pratt has two planes and a bottom-chord deck', () => {
    const model = prattTruss3d();
    expect(model.nodes).toHaveLength(14);
    expect(model.deck).toEqual([1, 2, 3]);
    expect(model.members.some((m) => m.releaseA.ty && m.releaseB.tz)).toBe(true);
    expect(analyzeStaticModel3d(model).kind).toBe('stable');
  });
});
