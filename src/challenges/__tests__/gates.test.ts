/**
 * G20 — challenge evaluation + curated gallery hashes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHALLENGES, CHALLENGE_SOLUTIONS } from '../catalog';
import {
  abutmentsOnly,
  clearSpanM,
  evaluateChallenge,
  steelMassKg,
  structureHeightM,
} from '../evaluate';
import { gallerySources } from '../../gallery/catalog';
import { decodeModel, encodeModelUncompressed } from '../../share/serialize';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('G20 — challenges & gallery (Phase 2G)', () => {
  it('G20a: steel mass, clear span, abutments-only, and height match hand geometry', () => {
    const solution = CHALLENGE_SOLUTIONS['span-40-steel-6t']!;
    expect(clearSpanM(solution)).toBe(40);
    expect(abutmentsOnly(solution)).toBe(true);
    expect(structureHeightM(solution)).toBe(0);
    // A = 2·b·tf + tw·(h−2tf); mass = ρ A L with L = 40 m.
    const section = solution.members[0]!.section;
    if (section.kind !== 'ibeam') throw new Error('expected ibeam');
    const A = 2 * section.b * section.tf + section.tw * (section.h - 2 * section.tf);
    expect(steelMassKg(solution)).toBeCloseTo(7850 * A * 40, 6);

    const withPier = {
      ...solution,
      nodes: [...solution.nodes, { id: 99, x: 0, y: 0 }],
      supports: [...solution.supports, { node: 99, kind: 'pin' as const }],
    };
    expect(abutmentsOnly(withPier)).toBe(false);
  });

  it('G20b: each challenge starter fails and its reference solution passes', () => {
    for (const challenge of CHALLENGES) {
      expect(evaluateChallenge(challenge, challenge.starter).passed).toBe(false);
      const solution = CHALLENGE_SOLUTIONS[challenge.id];
      expect(solution).toBeDefined();
      const verdict = evaluateChallenge(challenge, solution!);
      expect(verdict.passed, `${challenge.id}: ${JSON.stringify(verdict.checks)}`).toBe(true);
      expect(verdict.steelMassKg).toBeLessThanOrEqual(challenge.constraints.maxSteelMassKg);
    }
  });

  it('G20c: over-budget steel fails even when capacity would otherwise pass', () => {
    const challenge = CHALLENGES.find((item) => item.id === 'efficient-24m')!;
    const solution = CHALLENGE_SOLUTIONS['efficient-24m']!;
    const fat = {
      ...solution,
      members: solution.members.map((member) => ({
        ...member,
        section: { kind: 'rect' as const, b: 0.2, h: 0.2 },
      })),
    };
    const verdict = evaluateChallenge(challenge, fat);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.id === 'steel-budget')?.ok).toBe(false);
  });

  it('G20d: curated gallery.json hashes decode to the authored gallery models', async () => {
    const raw = readFileSync(join(ROOT, 'public/gallery.json'), 'utf8');
    const entries = JSON.parse(raw) as Array<{ id: string; title: string; blurb: string; hash: string }>;
    const sources = gallerySources();
    expect(entries.length).toBe(sources.length);
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      const entry = entries[index]!;
      expect(entry.id).toBe(source.id);
      expect(entry.title).toBe(source.title);
      expect(entry.blurb).toBe(source.blurb);
      expect(entry.hash).toBe(encodeModelUncompressed(source.model));
      expect(await decodeModel(entry.hash)).toEqual(source.model);
    }
  });
});
