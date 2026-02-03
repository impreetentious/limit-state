/**
 * Vehicle mass lumped onto translational DOFs at axle contacts.
 */
import { assembleM, STANDARD_GRAVITY } from './assemble';
import type { AnalysisMesh } from './types';

export interface VehicleContact {
  element: number;
  xi: number;
  /** Axle mass in kg. */
  massKg: number;
}

/** Total vehicle mass from weight in kN: m = W·1000 / g. */
export function vehicleMassKg(weightkN: number): number {
  return (Math.max(0, weightkN) * 1000) / STANDARD_GRAVITY;
}

/**
 * Copy of the structure mass with vehicle point masses added to translational
 * diagonals (ux, uy) at element ends, linearly split by ξ.
 */
export function assembleMassWithVehicle(
  mesh: AnalysisMesh,
  contacts: readonly VehicleContact[],
): Float64Array {
  const M = assembleM(mesh);
  addLumpedVehicleMass(M, mesh, contacts);
  return M;
}

/**
 * Add vehicle point masses to translational diagonals only.
 * Split m·(1−ξ) to end a and m·ξ to end b.
 */
export function addLumpedVehicleMass(
  M: Float64Array,
  mesh: AnalysisMesh,
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
    addTranslationalMass(M, ndof, element.na, massA);
    addTranslationalMass(M, ndof, element.nb, massB);
  }
}

/** Sum of translational diagonal entries contributed by contacts (2 per node · mass). */
export function lumpedVehicleTranslationalTrace(contacts: readonly VehicleContact[]): number {
  // Each mass kg adds to both ux and uy ⇒ trace contribution 2m.
  let mass = 0;
  for (const contact of contacts) mass += contact.massKg;
  return 2 * mass;
}

function addTranslationalMass(M: Float64Array, ndof: number, node: number, mass: number): void {
  if (mass === 0) return;
  const ux = 3 * node;
  const uy = ux + 1;
  M[ux * ndof + ux] = M[ux * ndof + ux]! + mass;
  M[uy * ndof + uy] = M[uy * ndof + uy]! + mass;
}
