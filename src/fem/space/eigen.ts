/**
 * 3D modal / buckling wrappers around the dimension-agnostic eigen kernel.
 * docs/FEM-SPEC.md §4.5 / §4.9 / §14 3S.
 */
import { bucklingAssembled, modalAssembled } from '../eigen';
import type { EigenResult } from '../types';
import { assembleK3dDense, assembleKg3d, assembleM3d } from './assemble';
import type { AnalysisMesh3d } from './types';

/** Space-frame buckling under tension-positive element axial forces. */
export function buckling3d(mesh: AnalysisMesh3d, elementN: Float64Array): EigenResult {
  return bucklingAssembled(mesh, assembleK3dDense(mesh), assembleKg3d(mesh, elementN));
}

/** Space-frame modal analysis (lowest nModes). */
export function modal3d(mesh: AnalysisMesh3d, nModes: number): EigenResult {
  return modalAssembled(mesh, assembleK3dDense(mesh), assembleM3d(mesh), nModes);
}
