/**
 * Vehicle mass lumped onto translational DOFs for 3D traffic.
 * docs/FEM-SPEC.md §4.1 / §14 2H / 3Y.
 */
import { assembleM3d } from './assemble';
import type { AnalysisMesh3d } from './types';
import type { VehicleContact } from '../moving-mass';

export type { VehicleContact };
export { vehicleMassKg } from '../moving-mass';

/**
 * Structure mass + vehicle point masses on ux,uy,uz diagonals, split by ξ.
 * docs/FEM-SPEC.md §4.1 / §14 3Y.
 */
export function assembleMassWithVehicle3d(
  mesh: AnalysisMesh3d,
  contacts: readonly VehicleContact[],
): Float64Array {
  const M = assembleM3d(mesh);
  addLumpedVehicleMass3d(M, mesh, contacts);
  return M;
}

export function addLumpedVehicleMass3d(
  M: Float64Array,
  mesh: AnalysisMesh3d,
  contacts: readonly VehicleContact[],
): void {
  const ndof = mesh.ndof;
  if (M.length !== ndof * ndof) throw new Error('Mass matrix size does not match the mesh.');
  for (const contact of contacts) {
    const element = mesh.elements[contact.element];
    if (!element) throw new Error(`Vehicle contact references missing element ${contact.element}.`);
    if (!(contact.xi >= 0 && contact.xi <= 1))
      throw new Error('Vehicle contact ξ must be within [0, 1].');
    if (!(contact.massKg >= 0) || !Number.isFinite(contact.massKg)) {
      throw new Error('Vehicle contact mass must be finite and non-negative.');
    }
    const massA = contact.massKg * (1 - contact.xi);
    const massB = contact.massKg * contact.xi;
    addTranslationalMass3d(M, ndof, element.na, massA);
    addTranslationalMass3d(M, ndof, element.nb, massB);
  }
}

/** Trace contribution: 3 translational diagonals × mass. */
export function lumpedVehicleTranslationalTrace3d(contacts: readonly VehicleContact[]): number {
  let mass = 0;
  for (const contact of contacts) mass += contact.massKg;
  return 3 * mass;
}

function addTranslationalMass3d(M: Float64Array, ndof: number, node: number, mass: number): void {
  if (mass === 0) return;
  const base = 6 * node;
  for (let i = 0; i < 3; i++) {
    const dof = base + i;
    M[dof * ndof + dof] = M[dof * ndof + dof]! + mass;
  }
}
