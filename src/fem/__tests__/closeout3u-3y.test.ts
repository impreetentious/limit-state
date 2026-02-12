/**
 * Phase 3 closeout gates for 3U–3Y. docs/FEM-SPEC.md §14.
 */
import { describe, expect, it } from 'vitest';
import { MATERIALS, plasticMoment } from '../materials';
import { solveTensionOnly3d } from '../space/cables';
import { evaluateFailure3d } from '../space/failure';
import { runPushover3d } from '../space/pushover';
import {
  assembleMassWithVehicle3d,
  lumpedVehicleTranslationalTrace3d,
  vehicleMassKg,
} from '../space/moving-mass';
import { buildMesh3d } from '../space/mesh';
import { NO_RELEASES, type EditorModel3d } from '../space/types';
import { guyedMast3d, portalPushover3d, PRESETS_3D, radioMast3d } from '../../presets/scenes3d';
import { prepareTraffic3d, vehicleContactsAt3d } from '../../stories/traffic3d';
import { analyzeRamp3d, rampCapacity3d } from '../../stories/ramp3d';

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe('Phase 3 closeout — 3U share round-trip', () => {
  it('authored 3D presets encode/decode round-trip (property)', async () => {
    const { encodeModel3d, decodeModel3d } = await import('../../share/serialize');
    for (const preset of PRESETS_3D) {
      if (preset.id === 'blank') continue;
      const model = preset.build();
      const round = await decodeModel3d(await encodeModel3d(model));
      expect(round).toEqual(model);
    }
  });

  it('peekShareSchemaVersion distinguishes v1 and v2', async () => {
    const { encodeModel, encodeModel3d, peekShareSchemaVersion } =
      await import('../../share/serialize');
    const v2 = await encodeModel3d(radioMast3d());
    expect(await peekShareSchemaVersion(v2)).toBe(2);
    const v1 = await encodeModel({
      v: 1,
      name: 'beam',
      seed: 1,
      nodes: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 1, y: 0 },
      ],
      members: [
        {
          id: 1,
          a: 1,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'rect', b: 0.1, h: 0.2 },
          releaseA: false,
          releaseB: false,
          cableOnly: false,
        },
      ],
      supports: [{ node: 1, kind: 'fixed' }],
      loads: { gravity: false, points: [] },
      deck: [],
      story: { kind: 'ramp' },
    });
    expect(await peekShareSchemaVersion(v1)).toBe(1);
  });
});

describe('Phase 3 closeout — 3V ramp + failure', () => {
  it('radio mast ramp reports a finite capacity factor', () => {
    const model = radioMast3d();
    const capacity = rampCapacity3d(model);
    expect(capacity).toBeDefined();
    expect(capacity!).toBeGreaterThan(0);
    expect(Number.isFinite(capacity!)).toBe(true);
    const frame = analyzeRamp3d(model, capacity!, true);
    expect(frame.report).toBeDefined();
    expect(
      frame.report!.kind === 'stable' ||
        frame.report!.kind === 'yield' ||
        frame.report!.kind === 'buckling',
    ).toBe(true);
  });

  it('evaluateFailure3d at tiny factor is stable with finite capacity', () => {
    const report = evaluateFailure3d(radioMast3d(), 0.01);
    expect(report.kind).toBe('stable');
    if (report.kind === 'stable') {
      expect(report.capacityFactor).toBeGreaterThan(0);
      expect(Number.isFinite(report.capacityFactor)).toBe(true);
    }
  });
});

describe('Phase 3 closeout — 3W pushover', () => {
  it('portal pushover collapse shear within 5% of 4M_p/h', () => {
    const model = portalPushover3d();
    const h = 4;
    const section = { kind: 'rect' as const, b: 0.2, h: 0.3 };
    const Mp = plasticMoment(section, MATERIALS['steel-s355'].fy);
    const expected = (4 * Mp) / h;
    const result = runPushover3d(model);
    expect(result.outcome).toBe('mechanism');
    expect(result.hinges.length).toBeGreaterThanOrEqual(2);
    expect(relativeError(result.collapseBaseShear, expected)).toBeLessThan(0.05);
  });
});

describe('Phase 3 closeout — 3X cables', () => {
  it('guyed mast: load-side guy slacks, restraint guy stays taut', () => {
    const model = guyedMast3d();
    const result = solveTensionOnly3d(model);
    expect(result.analysis.kind).toBe('stable');
    expect(result.frozen).toBe(false);
    // +Fx at tip: guys on −X (id 2) and +X (id 3). Restraint = 2, load-side = 3.
    expect(result.activeCables).toContain(2);
    expect(result.slackCables).toContain(3);
  });
});

describe('Phase 3 closeout — 3Y moving-mass lumping', () => {
  it('vehicle mass trace triples for 3D translational diagonals', () => {
    const model: EditorModel3d = {
      v: 2,
      name: 'deck',
      seed: 1,
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 16, y: 0, z: 0 },
      ],
      members: [
        {
          id: 1,
          a: 1,
          b: 2,
          material: 'steel-s355',
          section: { kind: 'box', b: 0.3, h: 0.5, t: 0.02 },
          releaseA: NO_RELEASES,
          releaseB: NO_RELEASES,
          roll: 0,
          cableOnly: false,
        },
      ],
      supports: [
        { node: 1, kind: 'fixed' },
        { node: 2, kind: 'pin' },
      ],
      loads: { gravity: false, points: [] },
      deck: [1],
      story: { kind: 'traffic', weightkN: 200, speed: 10, movingMass: true },
    };
    const scenario = prepareTraffic3d(model);
    const contacts = vehicleContactsAt3d(scenario, 8);
    expect(contacts.length).toBe(2);
    const mass = vehicleMassKg(200);
    expect(lumpedVehicleTranslationalTrace3d(contacts)).toBeCloseTo(3 * mass, 6);
    const mesh = buildMesh3d(model);
    const M = assembleMassWithVehicle3d(mesh, contacts);
    let trace = 0;
    for (let i = 0; i < mesh.ndof; i++) trace += M[i * mesh.ndof + i]!;
    // Structure mass + 3× vehicle mass on translational diagonals.
    expect(trace).toBeGreaterThan(3 * mass);
  });
});
