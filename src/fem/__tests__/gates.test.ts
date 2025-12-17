/**
 * The honesty gates. Tolerances are measured, not aspirational
 * (they were validated numerically before the plan was written; see §13.A).
 * Each milestone converts its `it.todo` rows into real tests.
 */
import { describe, expect, it } from 'vitest';
import { kLocal, kgLocal, mLocal, transformToGlobal } from '../assemble';
import { sectionProps } from '../materials';

const E = 1,
  A = 1,
  I = 1,
  L = 1,
  rho = 1;

describe('element matrices (implemented — scaffold anchor)', () => {
  it('kLocal is symmetric with textbook entries', () => {
    const k = kLocal(E, A, I, L);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) expect(k[i * 6 + j]).toBeCloseTo(k[j * 6 + i]!, 12);
    expect(k[0]).toBeCloseTo(E * A / L, 12); // EA/L
    expect(k[7]).toBeCloseTo(12, 12); // 12EI/L³
    expect(k[14]).toBeCloseTo(4, 12); // 4EI/L
    expect(k[17]).toBeCloseTo(2, 12); // 2EI/L
  });

  it('G1: cantilever tip deflection PL³/3EI and rotation PL²/2EI (bending block closed form)', () => {
    // Free DOFs of the tip node under transverse P=1: solve the 2x2 [v,θ] block.
    const k = kLocal(E, A, I, L);
    const k11 = k[4 * 6 + 4]!; // 12EI/L³
    const k12 = k[4 * 6 + 5]!; // -6EI/L²
    const k22 = k[5 * 6 + 5]!; // 4EI/L
    const det = k11 * k22 - k12 * k12;
    const v = k22 / det;
    const th = -k12 / det;
    expect(v).toBeCloseTo(1 / 3, 10); // PL³/3EI
    expect(th).toBeCloseTo(1 / 2, 10); // PL²/2EI
  });

  it('kgLocal: consistent geometric stiffness entries and symmetry', () => {
    const g = kgLocal(-1, L); // unit compression
    expect(g[1 * 6 + 1]).toBeCloseTo(-6 / 5, 12);
    expect(g[2 * 6 + 2]).toBeCloseTo(-2 / 15, 12);
    expect(g[2 * 6 + 5]).toBeCloseTo(1 / 30, 12);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) expect(g[i * 6 + j]).toBeCloseTo(g[j * 6 + i]!, 12);
  });

  it('mLocal: consistent mass entries, symmetry, and total mass', () => {
    const m = mLocal(rho, A, L);
    expect(m[1 * 6 + 1]).toBeCloseTo(156 / 420, 12);
    expect(m[1 * 6 + 4]).toBeCloseTo(54 / 420, 12);
    // translational mass sums to ρAL per direction
    let sum = 0;
    for (const i of [1, 4]) for (const j of [1, 4]) sum += m[i * 6 + j]!;
    expect(sum).toBeCloseTo(rho * A * L, 12);
  });

  it('transformToGlobal preserves symmetry and eigen-invariants (trace)', () => {
    const k = kLocal(2, 3, 0.5, 1.7);
    const kg = transformToGlobal(k, Math.cos(0.7), Math.sin(0.7));
    let trLocal = 0,
      trGlobal = 0;
    for (let i = 0; i < 6; i++) {
      trLocal += k[i * 6 + i]!;
      trGlobal += kg[i * 6 + i]!;
      for (let j = 0; j < 6; j++) expect(kg[i * 6 + j]).toBeCloseTo(kg[j * 6 + i]!, 9);
    }
    expect(trGlobal).toBeCloseTo(trLocal, 9); // similarity transform preserves trace
  });

  it('G10: section properties vs hand calcs', () => {
    const r = sectionProps({ kind: 'rect', b: 0.2, h: 0.4 });
    expect(r.A).toBeCloseTo(0.08, 12);
    expect(r.I).toBeCloseTo((0.2 * 0.4 ** 3) / 12, 15);
    const t = sectionProps({ kind: 'tube', d: 0.2, t: 0.01 });
    expect(t.A).toBeCloseTo((Math.PI / 4) * (0.2 ** 2 - 0.18 ** 2), 12);
  });
});

describe('M1 gates — statics', () => {
  it.todo('G2: SS beam UDL midspan = 5wL⁴/384EI at mid-node, rel err < 1e-10');
  it.todo('G5: assembled K symmetric; Betti reciprocity δ_ab=δ_ba on seeded random frames, 1e-9');
  it.todo('G6: unsupported/underbraced models flagged as mechanism with correct node');
  it.todo('G7: released (truss) members carry |M| < 1e-8 under nodal loads');
  it.todo('G13: in-element point load — reactions sum to P (1e-10), response continuous in ξ');
});

describe('M4 gates — eigenanalysis', () => {
  it.todo('G3: pinned column λ_cr = 9.9438 (2 elem) vs π² = 9.8696, within +0.8% (measured +0.75%)');
  it.todo('G3b: 4 elem λ_cr within +0.1% of π² (measured +0.051%)');
  it.todo('G4: SS beam ω₁ = 9.9086 (2 elem) vs π² rad/s, within +0.5% (measured +0.39%)');
});

describe('M5 gates — dynamics', () => {
  it.todo('G8: Newmark SDOF at resonance, ζ=2%: steady amplitude = static × 25, within 2% after 50 cycles');
  it.todo('G9: Rayleigh fit reproduces target ζ at ω₁ and ω₂ to 1e-6');
});

describe('M6/M7 gates — failure & sharing', () => {
  it.todo('G12: cascade on overloaded preset 4 reproduces frozen golden step sequence');
  it.todo('G11: property — decodeModel(encodeModel(m)) deep-equals m for seeded random models (both #m and #mu paths)');
});
