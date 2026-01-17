import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../traffic';
import { prepareWind, windLoadAt } from '../wind';
import type { EditorModel } from '../../fem/types';

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
    }],
    supports: [{ node: 1, kind: 'pin' }, { node: 2, kind: 'roller' }],
    loads: { gravity: false, points: [] },
    deck: [],
    story,
  };
}
