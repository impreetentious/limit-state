/**
 * Skyline storage + LDLᵀ — docs/FEM-SPEC.md §14 3S.
 */
import { describe, expect, it } from 'vitest';
import {
  createSkyline,
  factorSkylineLDLT,
  freeSkyline,
  matvecSkyline,
  profileFromDofGroups,
  skylineAdd,
  skylineNnz,
  skylineToDense,
  solveSkylineFactored,
} from '../skyline';
import { assembleK3d } from '../space/assemble';
import { buildMesh3d, NO_RELEASES, prepareStaticSystem3d, type EditorModel3d } from '../space';
import { factorLDLT, freeMatrix, solveFactored } from '../solve';

function cantilever(): EditorModel3d {
  return {
    v: 2,
    name: 'c',
    seed: 1,
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 2, y: 0, z: 0 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: 'steel-s355',
        section: { kind: 'rect', b: 0.2, h: 0.3 },
        releaseA: NO_RELEASES,
        releaseB: NO_RELEASES,
        roll: 0,
      },
    ],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [{ node: 2, fx: 0, fy: -1e3, fz: 0 }] },
  };
}

describe('skyline (Phase 3 closeout 3S)', () => {
  it('matches dense LDLᵀ on a free partition', () => {
    const mesh = buildMesh3d(cantilever());
    const K = assembleK3d(mesh);
    const dense = skylineToDense(K);
    for (let i = 0; i < mesh.ndof; i++) {
      for (let j = 0; j < mesh.ndof; j++) {
        expect(dense[i * mesh.ndof + j]).toBeCloseTo(dense[j * mesh.ndof + i]!, 12);
      }
    }
    const KffSky = freeSkyline(K, mesh.freeDofs).Kff;
    const KffDense = freeMatrix(dense, mesh.ndof, mesh.freeDofs);
    const sky = factorSkylineLDLT(KffSky);
    const den = factorLDLT(KffDense, mesh.freeDofs.length);
    expect(sky.ok).toBe(true);
    expect(den.ok).toBe(true);
    if (!sky.ok || !den.ok) return;
    const rhs = new Float64Array(mesh.freeDofs.length);
    rhs[1] = -1000;
    const us = solveSkylineFactored(sky.factor, rhs);
    const ud = solveFactored(den.factor, rhs);
    for (let i = 0; i < us.length; i++) expect(us[i]).toBeCloseTo(ud[i]!, 9);
  });

  it('matvec agrees with dense multiply', () => {
    const mesh = buildMesh3d(cantilever());
    const K = assembleK3d(mesh);
    const dense = skylineToDense(K);
    const x = new Float64Array(mesh.ndof);
    for (let i = 0; i < x.length; i++) x[i] = ((i * 17) % 10) / 10;
    const ys = matvecSkyline(K, x);
    for (let i = 0; i < mesh.ndof; i++) {
      let yd = 0;
      for (let j = 0; j < mesh.ndof; j++) yd += dense[i * mesh.ndof + j]! * x[j]!;
      expect(ys[i]).toBeCloseTo(yd, 9);
    }
  });

  it('profile packing is far below dense n² on a lattice', () => {
    const nx = 4;
    const ny = 3;
    const nz = 3;
    const dx = 4;
    const dy = 4;
    const dz = 3;
    const nodes: EditorModel3d['nodes'] = [];
    const idAt = (i: number, j: number, k: number) =>
      1 + i + j * (nx + 1) + k * (nx + 1) * (ny + 1);
    for (let k = 0; k <= nz; k++) {
      for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++)
          nodes.push({ id: idAt(i, j, k), x: i * dx, y: j * dy, z: k * dz });
      }
    }
    const members: EditorModel3d['members'] = [];
    let mid = 1;
    const section = { kind: 'box' as const, b: 0.2, h: 0.2, t: 0.008 };
    const add = (a: number, b: number) => {
      members.push({
        id: mid++,
        a,
        b,
        material: 'steel-s355',
        section,
        releaseA: NO_RELEASES,
        releaseB: NO_RELEASES,
        roll: 0,
      });
    };
    for (let k = 0; k <= nz; k++) {
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) add(idAt(i, j, k), idAt(i + 1, j, k));
      for (let i = 0; i <= nx; i++)
        for (let j = 0; j < ny; j++) add(idAt(i, j, k), idAt(i, j + 1, k));
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++)
        for (let k = 0; k < nz; k++) add(idAt(i, j, k), idAt(i, j, k + 1));
    }
    const supports: EditorModel3d['supports'] = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) supports.push({ node: idAt(i, j, 0), kind: 'fixed' });
    const model: EditorModel3d = {
      v: 2,
      name: 'lattice',
      seed: 1,
      nodes,
      members,
      supports,
      loads: { gravity: true, points: [] },
    };
    const mesh = buildMesh3d(model);
    const K = assembleK3d(mesh);
    // Lattice bandwidth is large without RCM; still well below full n² storage.
    expect(skylineNnz(K)).toBeLessThan(mesh.ndof * mesh.ndof);
    const t0 = performance.now();
    const system = prepareStaticSystem3d(mesh);
    const ms = performance.now() - t0;
    expect('factor' in system).toBe(true);
    // Dense factor was ~587 ms here; skyline must stay clearly faster.
    expect(ms).toBeLessThan(200);
  });

  it('createSkyline + add round-trips a tiny SPD system', () => {
    const first = profileFromDofGroups(3, [
      [0, 1],
      [1, 2],
    ]);
    const K = createSkyline(first);
    skylineAdd(K, 0, 0, 2);
    skylineAdd(K, 1, 0, -1);
    skylineAdd(K, 1, 1, 2);
    skylineAdd(K, 2, 1, -1);
    skylineAdd(K, 2, 2, 2);
    const factored = factorSkylineLDLT(K);
    expect(factored.ok).toBe(true);
    if (!factored.ok) return;
    const x = solveSkylineFactored(factored.factor, Float64Array.of(1, 0, 0));
    expect(x[0]).toBeCloseTo(0.75, 10);
  });

  it('keeps the RCM ordering a permutation when free DOFs fall into several components', () => {
    // Two connected free DOFs plus two isolated ones at higher indices. A
    // minimum-degree seed search that ranges outside the current component
    // ordered the isolated DOFs first, walked past the connected pair, and
    // returned a `perm` with a repeated index — silently corrupting K_ff.
    const freeDofs = Int32Array.of(0, 1, 2, 3);
    const groups = [[0, 1], [2], [3]];
    const K = createSkyline(Int32Array.of(0, 0, 2, 3));
    skylineAdd(K, 0, 0, 4);
    skylineAdd(K, 1, 0, 1);
    skylineAdd(K, 1, 1, 5);
    skylineAdd(K, 2, 2, 6);
    skylineAdd(K, 3, 3, 7);

    const { Kff, perm } = freeSkyline(K, freeDofs, groups);
    expect([...perm].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    // Reordering must preserve the matrix, so the diagonal is a permutation of
    // the original one and the system stays solvable.
    const dense = skylineToDense(Kff);
    const diagonal = [0, 1, 2, 3].map((i) => dense[i * 4 + i]!).sort((a, b) => a - b);
    expect(diagonal).toEqual([4, 5, 6, 7]);
    expect(factorSkylineLDLT(Kff).ok).toBe(true);
  });
});
