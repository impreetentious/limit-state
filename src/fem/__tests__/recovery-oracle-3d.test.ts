/**
 * Spatial twin of `recovery-oracle.test.ts` — gates G38/G39.
 *
 * The 2D oracles pin the §6.8 recovery contract (`f_local = k·(T u) + FEA`) and
 * the §4.1 fixed-end condensation. Nothing did the same one dimension up, so a
 * space-frame member load could reach the solve uncondensed and the recovered
 * actions could subtract the fixed-end vector instead of adding it, both
 * without a red test. These assertions are closed-form, not fixtures.
 *
 * docs/FEM-SPEC.md §4.1 / §4.2 / §4.9 / §6.8.
 */
import { describe, expect, it } from 'vitest';

import { MATERIALS, sectionProps } from '../materials';
import { STANDARD_GRAVITY } from '../assemble';
import { assembleLoadCase3d } from '../space/assemble';
import { buildMesh3d } from '../space/mesh';
import { analyzeStaticModel3d, solveStatic3d } from '../space/statics';
import { NO_RELEASES, TRUSS_RELEASES } from '../space/types';
import type { EditorModel3d, EndReleases3d, SupportKind3d } from '../space/types';

const SECTION = { kind: 'box', b: 0.2, h: 0.2, t: 0.008 } as const;
const L = 8;
/** Self-weight line load of the beam below, N/m. */
const W = MATERIALS['steel-s355'].rho * sectionProps(SECTION).A * STANDARD_GRAVITY;

/** One horizontal member along +X carrying only its own weight (global −Z). */
function beam(
  releaseA: EndReleases3d,
  releaseB: EndReleases3d,
  supportA: SupportKind3d,
  supportB: SupportKind3d,
): EditorModel3d {
  return {
    v: 2,
    name: 'recovery beam',
    seed: 1,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: L, y: 0, z: 0 },
    ],
    members: [
      { id: 1, a: 1, b: 2, material: 'steel-s355', section: SECTION, releaseA, releaseB, roll: 0 },
    ],
    supports: [
      { node: 1, kind: supportA },
      { node: 2, kind: supportB },
    ],
    loads: { gravity: true, points: [] },
  };
}

function stable(model: EditorModel3d) {
  const analysis = analyzeStaticModel3d(model);
  if (analysis.kind !== 'stable') {
    throw new Error(`Expected a stable beam, got ${analysis.kind}: ${JSON.stringify(analysis)}`);
  }
  return analysis;
}

/** Local end actions of the sub-element at the named end of member 1. */
function endActions(analysis: ReturnType<typeof stable>, end: 'a' | 'b') {
  const indices = analysis.mesh.elements.flatMap((element, index) =>
    element.memberId === 1 ? [index] : [],
  );
  const index = end === 'a' ? indices[0]! : indices.at(-1)!;
  const base = index * 12 + (end === 'a' ? 0 : 6);
  const forces = analysis.result.elementForces;
  return { fz: forces[base + 2]!, my: forces[base + 4]! };
}

describe('G38 — 3D internal-action recovery against closed forms', () => {
  it('recovers clamped-clamped self-weight end shear and moment', () => {
    const analysis = stable(beam(NO_RELEASES, NO_RELEASES, 'fixed', 'fixed'));
    const { fz, my } = endActions(analysis, 'a');

    // Before the recovery contract was applied in 3D this shear came out as
    // exactly zero: k·u is zero at a clamped end, so subtracting the fixed-end
    // vector instead of adding it cancelled the whole reaction.
    expect(Math.abs(fz)).toBeCloseTo((W * L) / 2, 6);
    expect(Math.abs(my)).toBeCloseTo((W * L * L) / 12, 6);

    // The independent Ku − F reaction path must agree with the recovered actions.
    const reaction = analysis.result.reactions.get(1)!;
    expect(reaction.fz).toBeCloseTo((W * L) / 2, 6);
    expect(Math.abs(reaction.my)).toBeCloseTo((W * L * L) / 12, 6);
  });

  it('condenses the fixed-end actions of a released end (propped cantilever)', () => {
    const hinge: EndReleases3d = { tx: false, ty: true, tz: true };
    const analysis = stable(beam(hinge, NO_RELEASES, 'pin', 'fixed'));

    // A hinge transmits no moment — this is what an uncondensed fixed-end
    // vector silently violates.
    expect(endActions(analysis, 'a').my).toBeCloseTo(0, 6);

    // Propped cantilever under UDL: R_pin = 3wL/8, M_fixed = wL²/8.
    expect(analysis.result.reactions.get(1)!.fz).toBeCloseTo((3 * W * L) / 8, 6);
    expect(Math.abs(analysis.result.reactions.get(2)!.my)).toBeCloseTo((W * L * L) / 8, 6);
  });

  it('recovers an in-element Hermite axle load (the traffic path)', () => {
    // Gravity off, so the only member load is the in-element one the traffic
    // sweep uses. A pinned end carries no moment however the span is loaded.
    const model = beam(NO_RELEASES, NO_RELEASES, 'pin', 'fixed');
    model.loads.gravity = false;
    const mesh = buildMesh3d(model);
    const P = 50_000;
    const loads = assembleLoadCase3d(mesh, {
      inElement: [{ element: 0, xi: 0.5, fx: 0, fy: 0, fz: -P }],
    });
    const analysis = solveStatic3d(mesh, loads.F, undefined, loads.elementFixedEnd);
    if (analysis.kind !== 'stable') throw new Error(`Expected stable, got ${analysis.kind}`);

    // No support moment and no second member at the pin, so the element's own
    // end moment there is zero. Subtracting the Hermite fixed-end vector
    // instead of adding it puts −2·FEA on this end.
    expect(analysis.result.elementForces[4]!).toBeCloseTo(0, 6);

    let fz = 0;
    for (const [, reaction] of analysis.result.reactions) fz += reaction.fz;
    expect(fz).toBeCloseTo(P, 6);
  });
});

describe('G39 — fully released space bar', () => {
  it('solves a both-ends-released bar as a pin-ended axial member', () => {
    // θx released at both ends is a torsional rigid-body mode: condensing it
    // would invert a singular block and reject the model outright.
    const analysis = stable(beam(TRUSS_RELEASES, TRUSS_RELEASES, 'pin', 'pin'));

    for (const node of [1, 2]) {
      const reaction = analysis.result.reactions.get(node)!;
      expect(reaction.fz).toBeCloseTo((W * L) / 2, 6);
      expect(reaction.mx).toBeCloseTo(0, 9);
      expect(reaction.my).toBeCloseTo(0, 9);
      expect(reaction.mz).toBeCloseTo(0, 9);
    }

    for (const end of ['a', 'b'] as const) {
      expect(endActions(analysis, end).my).toBeCloseTo(0, 9);
    }
  });
});
