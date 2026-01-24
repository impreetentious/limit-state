import { describe, expect, it } from 'vitest';
import { analyzeTraffic, prepareTraffic, trafficYieldWeightAt } from '../traffic';
import { detectResonance, measuredDaf, prepareWind, windLoadAt } from '../wind';
import { computeInfluenceLine, envelopeFromInfluence, memberMomentEnvelopeFromInfluence } from '../../fem/influence';
import { modal } from '../../fem/eigen';
import { buildMesh } from '../../fem/mesh';
import type { EditorModel, EigenResult } from '../../fem/types';
import { PRESETS } from '../../presets/scenes';

describe('story controllers', () => {
  it('maps a smooth two-axle traffic load to the deck and preserves total vehicle load', () => {
    const model = simpleBeam({ kind: 'traffic', weightkN: 300, speed: 12 });
    model.deck = [1];
    const frame = analyzeTraffic(model, 4);
    expect(frame.axles).toHaveLength(2);
    expect(frame.axles.map((axle) => axle.station)).toEqual([4, 0]);
    if (frame.analysis.kind !== 'stable') throw new Error('Expected stable traffic beam.');
    const vertical = Array.from(frame.analysis.loads.F).filter((_, index) => index % 3 === 1).reduce((sum, value) => sum + value, 0);
    expect(vertical).toBeCloseTo(-300_000, 7);
  });

  it('finds a finite yield-only vehicle capacity when the traffic story is paused', () => {
    const model = simpleBeam({ kind: 'traffic', weightkN: 300, speed: 12 });
    model.deck = [1];
    const capacity = trafficYieldWeightAt(prepareTraffic(model), 4);
    expect(capacity).toBeTypeOf('number');
    expect(capacity).toBeGreaterThan(0);
  });

  it('finds the Slender deck vehicle capacity used by the interactive traffic tab', () => {
    const preset = PRESETS.find((candidate) => candidate.id === 'slender-deck');
    if (!preset) throw new Error('Expected the Slender deck preset.');
    const model = { ...preset.model, story: { kind: 'traffic' as const, movingMass: false, weightkN: 300, speed: 12 } };
    const scenario = prepareTraffic(model);
    expect(trafficYieldWeightAt(scenario, 0)).toBeUndefined();
    const capacity = trafficYieldWeightAt(scenario, 30);
    expect(capacity).toBeTypeOf('number');
    expect(capacity).toBeGreaterThan(0);
  });

  it('retains static equilibrium loads while applying horizontal wind tributaries', () => {
    const model = simpleBeam({ kind: 'wind', pattern: 'steady', amplitudekNm: 2, freqHz: 1, zeta: 0.02 });
    model.nodes[1]!.x = 0;
    model.nodes[1]!.y = 8;
    const scenario = prepareWind(model);
    if (!scenario) throw new Error('Expected a wind scenario.');
    const load = windLoadAt(scenario, 0);
    expect(load[1]).toBe(scenario.baseLoad[1]);
    expect(load[0]).toBeGreaterThan(scenario.baseLoad[0]!);
    expect(load[3]).toBeGreaterThan(scenario.baseLoad[3]!);
  });

  it('applies the 2D pressure model to a horizontal deck instead of leaving it unexcited', () => {
    const scenario = prepareWind(simpleBeam({ kind: 'wind', pattern: 'steady', amplitudekNm: 2, freqHz: 1, zeta: 0.02 }));
    if (!scenario) throw new Error('Expected a wind scenario.');
    const load = windLoadAt(scenario, 0);
    expect(load[1]).toBeLessThan(scenario.baseLoad[1]!);
    expect(load[4]).toBeLessThan(scenario.baseLoad[4]!);
  });

  it('uses an actual five-cycle envelope and a modal static reference for amplification', () => {
    const modal: EigenResult = { kind: 'modal', values: new Float64Array([Math.PI * 2]), vectors: new Float64Array(), iterations: 0 };
    expect(detectResonance(1, modal, 0.02, [1, 1, 1, 1, 1, 1, 1, 1, 2], 2)).toBeUndefined();
    expect(detectResonance(1, modal, 0.02, [1, 1, 1, 1, 1, 1, 1, 1, 2, 2], 2)).toBe(0);
    expect(measuredDaf(new Float64Array([3, 1]), new Float64Array([1, 2]))).toEqual({ mode: 0, ratio: 3 });
  });

  it('keeps the Slender deck wind lesson tuned to its 0.3–0.5 Hz target', () => {
    const slenderDeck = PRESETS.find((preset) => preset.id === 'slender-deck');
    if (!slenderDeck) throw new Error('Expected the Slender deck preset.');
    const result = modal(buildMesh(slenderDeck.model), 1);
    const frequency = result.values[0]! / (Math.PI * 2);
    expect(frequency).toBeGreaterThanOrEqual(0.3);
    expect(frequency).toBeLessThanOrEqual(0.5);
  });

  it('builds a two-axle moment envelope from the midspan influence line', () => {
    const model = simpleBeam({ kind: 'traffic', weightkN: 200, speed: 12 });
    model.deck = [1];
    const line = computeInfluenceLine(model, { kind: 'moment', memberId: 1, at: 'mid' });
    const axleForce = 100_000;
    const fromLine = envelopeFromInfluence(line, axleForce);
    // Equal axles on an SS beam: peak midspan moment is W/2 · L/4 + W/2 · η(L/2−4).
    const L = 8;
    const expected = axleForce * (L / 4) + axleForce * ((L / 2 - 4) / 2);
    expect(relativeError(fromLine.maxAbs, expected)).toBeLessThan(1e-9);
    const members = memberMomentEnvelopeFromInfluence(model);
    expect(members.get(1)).toBeCloseTo(fromLine.maxAbs, 8);
  });
});

function simpleBeam(story: EditorModel['story']): EditorModel {
  return {
    v: 1,
    name: 'controller fixture',
    seed: 7,
    nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 8, y: 0 }],
    members: [{
      id: 1,
      a: 1,
      b: 2,
      material: 'steel-s355',
      section: { kind: 'rect', b: 0.2, h: 0.3 },
      releaseA: false,
      releaseB: false,
      cableOnly: false,
    }],
    supports: [{ node: 1, kind: 'pin' }, { node: 2, kind: 'roller' }],
    loads: { gravity: false, points: [] },
    deck: [],
    story,
  };
}

function relativeError(actual: number, expected: number): number {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) / scale;
}
