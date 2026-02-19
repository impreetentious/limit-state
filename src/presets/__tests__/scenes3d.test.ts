/**
 * Phase 3 preset polish — slender deck torsional mode + spatial rebuilds.
 * docs/FEM-SPEC.md §14 Phase 3 Polish / §7.
 */
import { describe, expect, it } from 'vitest';
import { analyzeStaticModel3d, buildMesh3d, modal3d } from '../../fem/space';
import { PRESETS_3D, prattTruss3d, slenderDeck3d } from '../scenes3d';

describe('3D presets (Phase 3 polish)', () => {
  // Drives the shipped menu itself, not a hand-listed subset: a preset that is
  // added to PRESETS_3D but forgotten here is exactly how an unsolvable scene
  // reaches the presets dropdown and the curated gallery.
  it('builds every teaching preset in the menu without a mechanism', () => {
    const scenes = PRESETS_3D.filter((preset) => preset.id !== 'blank');
    expect(scenes.length).toBe(PRESETS_3D.length - 1);

    for (const preset of scenes) {
      const model = preset.build();
      const mesh = buildMesh3d(model);
      expect(mesh.elements.length, preset.id).toBeGreaterThan(0);
      expect(mesh.freeDofs.length, preset.id).toBeGreaterThan(0);
      const analysis = analyzeStaticModel3d(model);
      expect(analysis.kind, `${preset.id} (${model.name})`).toBe('stable');
    }
  });

  // 3X: the hangers must carry load, not merely decorate. Deleting them leaves a
  // deck that still stands (it bears on the towers) but sags substantially more.
  it('suspension span: tension-only hangers relieve the deck and are not its restraint', () => {
    const model = PRESETS_3D.find((preset) => preset.id === 'suspension')!.build();
    const withoutHangers = { ...model, members: model.members.filter((m) => !m.cableOnly) };

    const sag = (candidate: typeof model) => {
      const analysis = analyzeStaticModel3d(candidate);
      expect(analysis.kind).toBe('stable');
      const u = (analysis as Extract<typeof analysis, { kind: 'stable' }>).result.u;
      let maxUz = 0;
      for (let node = 0; u.length > node * 6; node++) {
        maxUz = Math.max(maxUz, Math.abs(u[node * 6 + 2]!));
      }
      return maxUz;
    };

    expect(sag(model)).toBeLessThan(0.5 * sag(withoutHangers));
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
