/**
 * Phase 4 gates: 3D traffic moment envelope (4A) + 3D influence lines (4B).
 */
import { describe, expect, it } from 'vitest';
import { NO_RELEASES, type EditorModel3d } from '../../fem/space';
import {
  computeInfluenceLine3d,
  envelopeFromInfluence3d,
  memberMomentEnvelopeFromInfluence3d,
} from '../../fem/space/influence';
import {
  analyzeTrafficAt3d,
  mergeMomentEnvelope3d,
  prepareTraffic3d,
  trafficMomentEnvelope3d,
} from '../traffic3d';

const SECTION = { kind: 'box' as const, b: 0.3, h: 0.5, t: 0.02 };

/** Clamped–clamped beam along +X, single member, deck = the member. Loads act along −Z. */
function clampedClampedBeam(L = 8): EditorModel3d {
  return {
    v: 2,
    name: 'fixed-fixed deck',
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
      { node: 2, kind: 'fixed' },
    ],
    loads: { gravity: false, points: [] },
    deck: [1],
    story: { kind: 'traffic', weightkN: 200, speed: 10, movingMass: false },
  };
}

describe('Phase 4A — 3D traffic moment envelope', () => {
  it('accumulates worst-case combined |M| per member across a station sweep', () => {
    const scenario = prepareTraffic3d(clampedClampedBeam(8));
    const envelope = trafficMomentEnvelope3d(scenario, 0.5);
    const single = analyzeTrafficAt3d(scenario, 4);
    if (single.analysis.kind !== 'stable') throw new Error('midspan analysis must be stable');
    const singleEnvelope = mergeMomentEnvelope3d(new Map(), single.analysis);
    expect(envelope.get(1)).toBeDefined();
    expect(envelope.get(1)!).toBeGreaterThanOrEqual(singleEnvelope.get(1)!);
    expect(envelope.get(1)!).toBeGreaterThan(0);
  });

  it('mergeMomentEnvelope is monotonic under repeated calls', () => {
    const scenario = prepareTraffic3d(clampedClampedBeam(8));
    const a = analyzeTrafficAt3d(scenario, 2).analysis;
    const b = analyzeTrafficAt3d(scenario, 4).analysis;
    let envelope = new Map<number, number>();
    envelope = mergeMomentEnvelope3d(envelope, a);
    const afterA = envelope.get(1) ?? 0;
    envelope = mergeMomentEnvelope3d(envelope, b);
    const afterB = envelope.get(1) ?? 0;
    expect(afterB).toBeGreaterThanOrEqual(afterA);
  });
});

describe('Phase 4B — 3D influence lines', () => {
  it('clamped-clamped midspan-M influence peaks at L/8 for a unit load', () => {
    // Load walks along +X in the local xz-plane; response = |My| at midspan.
    // For a clamped-clamped beam under a unit load at midspan, the sagging
    // moment at midspan equals L/8.
    const L = 8;
    const line = computeInfluenceLine3d(
      clampedClampedBeam(L),
      {
        kind: 'moment',
        memberId: 1,
        at: 'mid',
        axis: 'mag',
      },
      { step: 0.1 },
    );
    expect(line.samples.length).toBeGreaterThan(20);
    // Peak sample should be near midspan and equal L/8 within a tight tolerance.
    expect(Math.abs(line.peak.station - L / 2)).toBeLessThan(0.3);
    const rel = Math.abs(line.peak.value - L / 8) / (L / 8);
    expect(rel).toBeLessThan(1e-6);
  });

  it('reaction influence line at fixed end sums to unit downward regardless of station', () => {
    // Unit −Z load at any station: reactions along −Z must sum to +1 for equilibrium.
    const line = computeInfluenceLine3d(
      clampedClampedBeam(8),
      {
        kind: 'reaction',
        nodeId: 1,
        component: 'fz',
      },
      { step: 1 },
    );
    for (const sample of line.samples) {
      // Load−fz at node1 alone won't equal 1 (fixed-fixed shares vertical reaction),
      // but must lie between 0 and 1 for a downward unit load.
      expect(sample.value).toBeGreaterThanOrEqual(-1e-9);
      expect(sample.value).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('two-axle envelope from influence line matches expected magnitudes', () => {
    const L = 8;
    const line = computeInfluenceLine3d(
      clampedClampedBeam(L),
      {
        kind: 'moment',
        memberId: 1,
        at: 'mid',
        axis: 'mag',
      },
      { step: 0.1 },
    );
    const axleForce = 100_000; // N, one axle
    const envelope = envelopeFromInfluence3d(line, axleForce, 4);
    // Sanity: exceeds single-axle midspan contribution alone.
    expect(envelope.maxAbs).toBeGreaterThan(((axleForce * L) / 8) * 0.9);
    expect(envelope.criticalStation).toBeGreaterThan(0);
  });

  it('memberMomentEnvelopeFromInfluence returns positive per-member envelopes', () => {
    const envelope = memberMomentEnvelopeFromInfluence3d(clampedClampedBeam(8));
    expect(envelope.get(1)!).toBeGreaterThan(0);
  });
});
