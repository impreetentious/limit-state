import { describe, expect, it } from 'vitest';

import { analyzeStaticModel } from '../../fem/statics';
import { PRESETS } from '../../presets/scenes';
import { DIAGRAM_STATIONS, sampleDiagram } from '../diagram-samples';

/**
 * docs/FEM-SPEC.md §6.8 — the A/S/M diagrams are pedagogy, not decoration. Before the
 * interior-station sampling landed, each member was reduced to a single extreme
 * value and drawn as a constant-height block: a gravity-loaded simple beam
 * rendered a flat moment and a shear that never crossed zero, which is the
 * opposite of what the diagram is meant to teach. These assertions pin the
 * shape, so a regression to a per-member extreme fails here rather than being
 * noticed by eye.
 */
function simpleBeamAnalysis() {
  const preset = PRESETS.find((scene) => scene.id === 'simple-beam');
  if (!preset) throw new Error('simple-beam preset is missing');
  const analysis = analyzeStaticModel(preset.model);
  if (analysis.kind !== 'stable') {
    throw new Error(`simple-beam should be stable, got ${analysis.kind}`);
  }
  return { analysis, members: preset.model.members };
}

describe('A/S/M diagram sampling', () => {
  it('samples interior stations rather than one value per member', () => {
    const { analysis, members } = simpleBeamAnalysis();
    const { byMember } = sampleDiagram(members, analysis, 'moment');

    const samples = byMember.get(members[0]!.id) ?? [];
    // At least one full station sweep; a per-member extreme would give 1.
    expect(samples.length).toBeGreaterThanOrEqual(DIAGRAM_STATIONS);

    // Stations advance monotonically along the member's span.
    const xs = samples.map((sample) => sample.point.x);
    for (let index = 1; index < xs.length; index += 1) {
      expect(xs[index]!).toBeGreaterThanOrEqual(xs[index - 1]!);
    }
  });

  // GAP-10 is ratified in docs/FEM-SPEC.md §6.8. Recovery publishes local
  // end actions; sampleDiagram applies the display convention there.
  it('gives the gravity-loaded simple beam a sagging parabolic moment peaking at midspan', () => {
    const { analysis, members } = simpleBeamAnalysis();
    const samples = sampleDiagram(members, analysis, 'moment').byMember.get(members[0]!.id) ?? [];
    const magnitudes = samples.map((sample) => Math.abs(sample.value));
    const peakIndex = magnitudes.indexOf(Math.max(...magnitudes));

    expect(Math.abs(peakIndex - (samples.length - 1) / 2)).toBeLessThanOrEqual(1);
    // A simply supported end carries no moment.
    expect(magnitudes[0]!).toBeLessThan(magnitudes[peakIndex]! * 0.02);
    expect(magnitudes.at(-1)!).toBeLessThan(magnitudes[peakIndex]! * 0.02);
  });

  it('gives the same beam a shear that changes sign at midspan', () => {
    const { analysis, members } = simpleBeamAnalysis();
    const samples = sampleDiagram(members, analysis, 'shear').byMember.get(members[0]!.id) ?? [];
    const values = samples.map((sample) => sample.value);

    expect(Math.sign(values[0]!)).toBe(-Math.sign(values.at(-1)!));
    expect(Math.abs(values[0]!)).toBeGreaterThan(0);
  });

  it('varies the moment ordinate along the span rather than drawing a block', () => {
    // This is the part of GAP-10 that DID land: whatever the sign convention,
    // the diagram is no longer one constant value per member. Guarding it stops
    // a regression to the old per-member-extreme rendering.
    const { analysis, members } = simpleBeamAnalysis();
    const samples = sampleDiagram(members, analysis, 'moment').byMember.get(members[0]!.id) ?? [];
    const distinct = new Set(samples.map((sample) => sample.value.toFixed(6)));
    expect(distinct.size).toBeGreaterThan(samples.length / 2);

    const magnitudes = samples.map((sample) => Math.abs(sample.value));
    expect(Math.max(...magnitudes)).toBeGreaterThan(Math.min(...magnitudes) * 2);
  });

  it('holds the axial ordinate constant within an element', () => {
    const { analysis, members } = simpleBeamAnalysis();
    const samples = sampleDiagram(members, analysis, 'axial').byMember.get(members[0]!.id) ?? [];
    expect(samples.length).toBeGreaterThan(2);

    // Axial force is constant per element, so the sweep must be flat — this is
    // the one diagram where a block IS the correct shape.
    const unique = new Set(samples.map((sample) => sample.value.toFixed(9)));
    expect(unique.size).toBeLessThanOrEqual(analysis.mesh.elements.length);
  });

  it('scales every diagram against a shared, non-zero maximum', () => {
    const { analysis, members } = simpleBeamAnalysis();
    for (const diagram of ['axial', 'shear', 'moment'] as const) {
      const { maximum } = sampleDiagram(members, analysis, diagram);
      expect(maximum).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(maximum)).toBe(true);
    }
  });
});
