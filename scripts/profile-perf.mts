/**
 * Phase 3 closeout 3R — measure assembly, factorization, cached backsolve,
 * and complete solve/recovery costs.
 * Run: npm run profile:perf
 * docs/FEM-SPEC.md §3 performance budgets / §14 3R.
 */
import { assembleK3d, assembleLoadCase3d } from '../src/fem/space/assemble';
import { buildMesh3d, NO_RELEASES, type EditorModel3d } from '../src/fem/space';
import { prepareStaticSystem3d, solveStatic3d } from '../src/fem/space/statics';
import { skylineNnz, solveSkylineFactored } from '../src/fem/skyline';
import { prepareStaticSystem, solveStatic } from '../src/fem/statics';
import { assembleK, assembleLoadCase, assembleM } from '../src/fem/assemble';
import { buildMesh } from '../src/fem/mesh';
import { factorLDLT, freeMatrix, freeVector, solveFactored } from '../src/fem/solve';
import { PRESETS } from '../src/presets/scenes';
import { prattTruss3d, slenderDeck3d, spaceFrameDemo } from '../src/presets/scenes3d';
import type { EditorModel } from '../src/fem/types';

function timeMs(fn: () => void, runs = 5): number {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - t0) / runs;
}

/** Lattice of fixed columns + beams along X — scales DOF for profiling. */
function lattice3d(nx: number, ny: number, nz: number): EditorModel3d {
  const dx = 4;
  const dy = 4;
  const dz = 3;
  const nodes: EditorModel3d['nodes'] = [];
  const idAt = (i: number, j: number, k: number) => 1 + i + j * (nx + 1) + k * (nx + 1) * (ny + 1);
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        nodes.push({ id: idAt(i, j, k), x: i * dx, y: j * dy, z: k * dz });
      }
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
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) add(idAt(i, j, k), idAt(i + 1, j, k));
    }
  }
  for (let k = 0; k <= nz; k++) {
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j < ny; j++) add(idAt(i, j, k), idAt(i, j + 1, k));
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      for (let k = 0; k < nz; k++) add(idAt(i, j, k), idAt(i, j, k + 1));
    }
  }
  const supports: EditorModel3d['supports'] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) supports.push({ node: idAt(i, j, 0), kind: 'fixed' });
  }
  return {
    v: 2,
    name: `lattice ${nx}×${ny}×${nz}`,
    seed: 1,
    nodes,
    members,
    supports,
    loads: { gravity: true, points: [] },
  };
}

function report2d(label: string, model: EditorModel): void {
  const mesh = buildMesh(model);
  const assembleMs = timeMs(() => {
    assembleK(mesh);
    assembleM(mesh);
  });
  const factorMs = timeMs(() => {
    const K = assembleK(mesh);
    factorLDLT(freeMatrix(K, mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
  });
  const system = prepareStaticSystem(mesh);
  const loads = assembleLoadCase(mesh, { gravity: model.loads.gravity, points: [] });
  if (!('factor' in system)) throw new Error(`${label} is a mechanism; cannot profile solve.`);
  const freeLoad = freeVector(loads.F, mesh.freeDofs);
  const backsolveMs = timeMs(() => {
    solveFactored(system.factor, freeLoad);
  });
  const solveMs = timeMs(() => {
    solveStatic(mesh, loads, system);
  }, 3);
  console.log(
    `2D ${label.padEnd(22)} members=${String(model.members.length).padStart(3)} ndof=${String(mesh.ndof).padStart(5)} free=${String(mesh.freeDofs.length).padStart(5)}  assemble+M ${assembleMs.toFixed(2)}ms  factor ${factorMs.toFixed(2)}ms  backsolve ${backsolveMs.toFixed(2)}ms  solve+recover ${solveMs.toFixed(2)}ms`,
  );
}

function report3d(label: string, model: EditorModel3d): void {
  const mesh = buildMesh3d(model);
  const assembleMs = timeMs(() => {
    assembleK3d(mesh);
  });
  const factorMs = timeMs(() => {
    prepareStaticSystem3d(mesh);
  });
  const K = assembleK3d(mesh);
  const system = prepareStaticSystem3d(mesh);
  const loads = assembleLoadCase3d(mesh, { gravity: model.loads.gravity });
  if (!('factor' in system)) throw new Error(`${label} is a mechanism; cannot profile solve.`);
  const freeLoad = freeVector(loads.F, mesh.freeDofs);
  const reorderedLoad = new Float64Array(freeLoad.length);
  for (let i = 0; i < freeLoad.length; i++) reorderedLoad[i] = freeLoad[system.freePerm[i]!]!;
  const backsolveMs = timeMs(() => {
    solveSkylineFactored(system.factor, reorderedLoad);
  });
  const solveMs = timeMs(() => {
    solveStatic3d(mesh, loads.F, system, loads.elementFixedEnd);
  }, 3);
  console.log(
    `3D ${label.padEnd(22)} members=${String(model.members.length).padStart(3)} ndof=${String(mesh.ndof).padStart(5)} free=${String(mesh.freeDofs.length).padStart(5)} nnz=${String(skylineNnz(K)).padStart(7)}  assembleK ${assembleMs.toFixed(2)}ms  factor ${factorMs.toFixed(2)}ms  backsolve ${backsolveMs.toFixed(2)}ms  solve+recover ${solveMs.toFixed(2)}ms`,
  );
}

console.log('=== Limit State perf profile (3R) ===');
console.log('Budgets (§3): refactor <5ms @~300 elem; re-solve <1ms; Newmark 60fps @900 DOF\n');

const pratt = PRESETS.find((p) => p.id === 'pratt-truss')!.model;
const slender = PRESETS.find((p) => p.id === 'slender-deck')!.model;
report2d('Pratt truss', pratt);
report2d('Slender deck', slender);

report3d('Space frame', spaceFrameDemo());
report3d('Slender deck 3D', slenderDeck3d());
report3d('Pratt 3D', prattTruss3d());

// ~0.3k–1.5k DOF lattices (dense factor cost grows ~n³ — feeds 3S skyline decision)
report3d('lattice 2×2×2', lattice3d(2, 2, 2));
report3d('lattice 3×2×2', lattice3d(3, 2, 2));
report3d('lattice 5×3×2', lattice3d(5, 3, 2));
report3d('lattice 4×3×3', lattice3d(4, 3, 3));
