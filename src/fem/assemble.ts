/**
 * Element matrices, transforms, assembly, load vectors.
 * The three element matrices below are implemented and tested now (scaffold anchor);
 * assembly and load vectors are M1 work.
 *
 * Local DOF order: [u1, v1, th1, u2, v2, th2]. Tension-positive N, CCW-positive rotation.
 */
import type { AnalysisMesh, Element } from './types';

export interface LoadAssembly {
  /** Full global load vector. */
  F: Float64Array;
  /** Condensed local fixed-end forces, six entries per analysis element. */
  elementFixedEnd: Float64Array;
  /** Signed local-y uniform load intensity per element (positive local +y). */
  elementTransverseUdl: Float64Array;
}

/**
 * Shear flexibility factor φ = 12EI / (G A_s L²).
 * φ → 0 recovers Euler–Bernoulli.
 */
export function shearFactor(E: number, I: number, G: number, As: number, L: number): number {
  if (!(G > 0 && As > 0 && L > 0)) return 0;
  return (12 * E * I) / (G * As * L * L);
}

/**
 * Frame element stiffness, local axes.
 * Optional φ applies the standard Timoshenko (1+φ) bending block; φ = 0 is Euler–Bernoulli.
 */
export function kLocal(E: number, A: number, I: number, L: number, phi = 0): Float64Array {
  const k = new Float64Array(36);
  const a = (E * A) / L;
  const denom = 1 + phi;
  const b = (E * I) / (L * L * L * denom);
  const set = (i: number, j: number, v: number) => {
    k[i * 6 + j] = v;
    if (i !== j) k[j * 6 + i] = v;
  };
  set(0, 0, a);
  set(3, 3, a);
  set(0, 3, -a);
  set(1, 1, 12 * b);
  set(4, 4, 12 * b);
  set(1, 4, -12 * b);
  set(1, 2, 6 * b * L);
  set(1, 5, 6 * b * L);
  set(2, 4, -6 * b * L);
  set(4, 5, -6 * b * L);
  set(2, 2, (4 + phi) * b * L * L);
  set(5, 5, (4 + phi) * b * L * L);
  set(2, 5, (2 - phi) * b * L * L);
  return k;
}

/** Element φ from mesh analysis option and section shear props. */
export function elementPhi(element: Element, shearFlexible: boolean): number {
  if (!shearFlexible) return 0;
  return shearFactor(element.E, element.I, element.G, element.As, element.L);
}

/** Consistent geometric stiffness (transverse/rotation block), N tension-positive. */
export function kgLocal(N: number, L: number): Float64Array {
  const g = new Float64Array(36);
  const c = N / L;
  const idx = [1, 2, 4, 5];
  const m = [
    [6 / 5, L / 10, -6 / 5, L / 10],
    [L / 10, (2 * L * L) / 15, -L / 10, (-L * L) / 30],
    [-6 / 5, -L / 10, 6 / 5, -L / 10],
    [L / 10, (-L * L) / 30, -L / 10, (2 * L * L) / 15],
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) g[idx[i]! * 6 + idx[j]!] = c * m[i]![j]!;
  return g;
}

/** Consistent mass matrix, local axes. */
export function mLocal(rho: number, A: number, L: number): Float64Array {
  const m = new Float64Array(36);
  const ax = (rho * A * L) / 6;
  m[0] = 2 * ax;
  m[21] = 2 * ax;
  m[3] = ax;
  m[18] = ax;
  const c = (rho * A * L) / 420;
  const b = [
    [156, 22 * L, 54, -13 * L],
    [22 * L, 4 * L * L, 13 * L, -3 * L * L],
    [54, 13 * L, 156, -22 * L],
    [-13 * L, -3 * L * L, -22 * L, 4 * L * L],
  ];
  const idx = [1, 2, 4, 5];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) m[idx[i]! * 6 + idx[j]!] = c * b[i]![j]!;
  return m;
}

/** K_global = Tᵀ k T with per-node rotation blocks R = [[c,s,0],[-s,c,0],[0,0,1]]. */
export function transformToGlobal(kLoc: Float64Array, cos: number, sin: number): Float64Array {
  // T maps global -> local. Column transform then row transform, exploiting block structure.
  const out = new Float64Array(36);
  const t = new Float64Array(36);
  // t = kLoc * T
  for (let i = 0; i < 6; i++) {
    for (let blk = 0; blk < 2; blk++) {
      const o = blk * 3;
      const a = kLoc[i * 6 + o]!;
      const b = kLoc[i * 6 + o + 1]!;
      t[i * 6 + o] = a * cos - b * sin;
      t[i * 6 + o + 1] = a * sin + b * cos;
      t[i * 6 + o + 2] = kLoc[i * 6 + o + 2]!;
    }
  }
  // out = Tᵀ * t
  for (let j = 0; j < 6; j++) {
    for (let blk = 0; blk < 2; blk++) {
      const o = blk * 3;
      const a = t[o * 6 + j]!;
      const b = t[(o + 1) * 6 + j]!;
      out[o * 6 + j] = a * cos - b * sin;
      out[(o + 1) * 6 + j] = a * sin + b * cos;
      out[(o + 2) * 6 + j] = t[(o + 2) * 6 + j]!;
    }
  }
  return out;
}

/** Assemble global K (dense, row-major ndof×ndof). M1. */
export function assembleK(mesh: AnalysisMesh): Float64Array {
  const K = new Float64Array(mesh.ndof * mesh.ndof);
  for (const element of mesh.elements) {
    const local = elementLocalStiffness(element, mesh.shearFlexible);
    addElementMatrix(K, mesh.ndof, transformToGlobal(local, element.cos, element.sin), element);
  }
  return K;
}

/** Local element stiffness after end-release condensation. */
export function elementLocalStiffness(element: Element, shearFlexible = false): Float64Array {
  const phi = elementPhi(element, shearFlexible);
  return condenseReleased(kLocal(element.E, element.A, element.I, element.L, phi), element, phi);
}

/** Assemble global consistent M, including release-compatible mass condensation. */
export function assembleM(mesh: AnalysisMesh): Float64Array {
  const M = new Float64Array(mesh.ndof * mesh.ndof);
  for (const element of mesh.elements) {
    const phi = elementPhi(element, mesh.shearFlexible);
    const local = condenseReleased(mLocal(element.rho, element.A, element.L), element, phi);
    addElementMatrix(M, mesh.ndof, transformToGlobal(local, element.cos, element.sin), element);
  }
  return M;
}

/** Assemble K_g from tension-positive local element axial forces. */
export function assembleKg(mesh: AnalysisMesh, elementN: Float64Array): Float64Array {
  if (elementN.length !== mesh.elements.length) {
    throw new Error('Geometric stiffness requires exactly one axial force per analysis element.');
  }
  const Kg = new Float64Array(mesh.ndof * mesh.ndof);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    // A release constrains the compatible elastic shape, so use the same
    // k-based coordinate transform for k_g as for the consistent mass.
    const phi = elementPhi(element, mesh.shearFlexible);
    const local = condenseReleased(kgLocal(elementN[index]!, element.L), element, phi);
    addElementMatrix(Kg, mesh.ndof, transformToGlobal(local, element.cos, element.sin), element);
  }
  return Kg;
}

/** Global load vector: nodal + self-weight UDL + in-element point loads (Hermite). M1. */
export function assembleF(
  mesh: AnalysisMesh,
  opts: {
    gravity: boolean;
    points: { meshNode: number; fx: number; fy: number }[];
    /** traffic axles: element index + position ξ∈[0,1] + force (global -y) */
    inElement?: { element: number; xi: number; p: number }[];
    /** local downward UDLs (N/m), mainly used by static stories and verification gates */
    elementUdls?: { element: number; w: number }[];
  },
): Float64Array {
  return assembleLoadCase(mesh, opts).F;
}

/**
 * Assemble the global load vector and retained fixed-end forces for static
 * recovery.
 */
export function assembleLoadCase(
  mesh: AnalysisMesh,
  opts: {
    gravity: boolean;
    points: { meshNode: number; fx: number; fy: number }[];
    /** traffic axles: element index + position ξ∈[0,1] + force (global -y) */
    inElement?: { element: number; xi: number; p: number }[];
    /** local downward UDLs (N/m), mainly used by static stories and verification gates */
    elementUdls?: { element: number; w: number }[];
  },
): LoadAssembly {
  const F = new Float64Array(mesh.ndof);
  const elementFixedEnd = new Float64Array(mesh.elements.length * 6);
  const elementTransverseUdl = new Float64Array(mesh.elements.length);
  for (const point of opts.points) {
    if (
      !Number.isInteger(point.meshNode) ||
      point.meshNode < 0 ||
      point.meshNode * 3 >= mesh.ndof
    ) {
      throw new Error(`Point load references missing mesh node ${point.meshNode}.`);
    }
    const xDof = 3 * point.meshNode;
    const yDof = xDof + 1;
    F[xDof] = F[xDof]! + point.fx;
    F[yDof] = F[yDof]! + point.fy;
  }

  if (opts.gravity) {
    for (let index = 0; index < mesh.elements.length; index++) {
      const element = mesh.elements[index]!;
      const weight = element.rho * element.A * STANDARD_GRAVITY;
      elementTransverseUdl[index] = elementTransverseUdl[index]! - weight * element.cos;
      // Global gravity (0, -rho*A*g) resolved into local x/y components.
      addEquivalentLocalLoad(
        F,
        mesh,
        index,
        uniformFixedEnd(-weight * element.sin, -weight * element.cos, element.L),
        elementFixedEnd,
      );
    }
  }

  for (const udl of opts.elementUdls ?? []) {
    const element = mesh.elements[udl.element];
    if (!element) throw new Error(`UDL references missing element ${udl.element}.`);
    elementTransverseUdl[udl.element] = elementTransverseUdl[udl.element]! - udl.w;
    addEquivalentLocalLoad(
      F,
      mesh,
      udl.element,
      uniformFixedEnd(0, -udl.w, element.L),
      elementFixedEnd,
    );
  }

  for (const axle of opts.inElement ?? []) {
    const element = mesh.elements[axle.element];
    if (!element) throw new Error(`In-element load references missing element ${axle.element}.`);
    if (!(axle.xi >= 0 && axle.xi <= 1))
      throw new Error('In-element load position xi must be within [0, 1].');
    // The force is global downward, resolved to the element's local axes.
    const localX = -axle.p * element.sin;
    const localY = -axle.p * element.cos;
    addEquivalentLocalLoad(
      F,
      mesh,
      axle.element,
      pointFixedEnd(localX, localY, axle.xi, element.L),
      elementFixedEnd,
    );
  }

  return { F, elementFixedEnd, elementTransverseUdl };
}

/** Standard gravity in m/s² for self-weight assembly. */
export const STANDARD_GRAVITY = 9.80665;

function addElementMatrix(
  global: Float64Array,
  ndof: number,
  local: Float64Array,
  element: Element,
): void {
  const dofs = elementDofs(element);
  for (let i = 0; i < 6; i++) {
    const row = dofs[i]!;
    for (let j = 0; j < 6; j++) {
      const index = row * ndof + dofs[j]!;
      global[index] = global[index]! + local[i * 6 + j]!;
    }
  }
}

function elementDofs(element: Element): readonly number[] {
  return [
    3 * element.na,
    3 * element.na + 1,
    3 * element.na + 2,
    3 * element.nb,
    3 * element.nb + 1,
    3 * element.nb + 2,
  ];
}

/**
 * Condense released rotational DOFs out of a local element matrix.
 * k_cond = k_kk - k_kr k_rr^-1 k_rk.
 */
function condenseReleased(local: Float64Array, element: Element, phi: number): Float64Array {
  const released = releasedRotations(element);
  if (released.length === 0) return local;
  const transform = releaseTransform(element, phi, released);
  const condensed = new Float64Array(36);
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 6; column++) {
      let value = 0;
      for (let i = 0; i < 6; i++) {
        const left = transform[i * 6 + row]!;
        if (left === 0) continue;
        for (let j = 0; j < 6; j++) value += left * local[i * 6 + j]! * transform[j * 6 + column]!;
      }
      condensed[row * 6 + column] = value;
    }
  }
  return condensed;
}

/**
 * Coordinate transform for a rotational end release:
 * q_r = -k_rr⁻¹ k_rk q_k, so every compatible matrix is Cᵀ A C.
 */
function releaseTransform(
  element: Element,
  phi: number,
  released = releasedRotations(element),
): Float64Array {
  const transform = new Float64Array(36);
  const kept = [0, 1, 2, 3, 4, 5].filter((dof) => !released.includes(dof));
  for (const dof of kept) transform[dof * 6 + dof] = 1;
  if (released.length === 0) return transform;

  const localK = kLocal(element.E, element.A, element.I, element.L, phi);
  const inverse = invertReleasedBlock(localK, released);
  for (let r = 0; r < released.length; r++) {
    const releasedDof = released[r]!;
    for (const keptDof of kept) {
      let value = 0;
      for (let s = 0; s < released.length; s++) {
        value -= inverse[r * released.length + s]! * localK[released[s]! * 6 + keptDof]!;
      }
      transform[releasedDof * 6 + keptDof] = value;
    }
  }
  return transform;
}

/**
 * Condense a fixed-end vector alongside the stiffness releases.
 * f_cond = f_k - k_kr k_rr^-1 f_r.
 */
function condenseFixedEnd(fixedEnd: Float64Array, element: Element, phi: number): Float64Array {
  const released = releasedRotations(element);
  if (released.length === 0) return fixedEnd;
  const local = kLocal(element.E, element.A, element.I, element.L, phi);
  const inverse = invertReleasedBlock(local, released);
  const condensed = new Float64Array(6);
  for (let i = 0; i < 6; i++) {
    if (released.includes(i)) continue;
    let value = fixedEnd[i]!;
    for (let r = 0; r < released.length; r++) {
      for (let s = 0; s < released.length; s++) {
        const releasedR = released[r]!;
        const releasedS = released[s]!;
        value -=
          local[i * 6 + releasedR]! * inverse[r * released.length + s]! * fixedEnd[releasedS]!;
      }
    }
    condensed[i] = value;
  }
  return condensed;
}

function releasedRotations(element: Element): number[] {
  const released: number[] = [];
  if (element.releaseA) released.push(2);
  if (element.releaseB) released.push(5);
  return released;
}

function invertReleasedBlock(local: Float64Array, released: readonly number[]): Float64Array {
  if (released.length === 1) {
    const value = local[released[0]! * 6 + released[0]!]!;
    if (value === 0) throw new Error('Cannot condense a zero-stiffness release block.');
    return Float64Array.of(1 / value);
  }
  const a = local[released[0]! * 6 + released[0]!]!;
  const b = local[released[0]! * 6 + released[1]!]!;
  const c = local[released[1]! * 6 + released[1]!]!;
  const determinant = a * c - b * b;
  if (determinant === 0) throw new Error('Cannot condense a singular release block.');
  return Float64Array.of(c / determinant, -b / determinant, -b / determinant, a / determinant);
}

function addEquivalentLocalLoad(
  global: Float64Array,
  mesh: AnalysisMesh,
  elementIndex: number,
  fixedEnd: Float64Array,
  fixedEndByElement?: Float64Array,
): void {
  const element = mesh.elements[elementIndex]!;
  const condensed = condenseFixedEnd(fixedEnd, element, elementPhi(element, mesh.shearFlexible));
  if (fixedEndByElement) {
    for (let i = 0; i < 6; i++) {
      const offset = elementIndex * 6 + i;
      fixedEndByElement[offset] = fixedEndByElement[offset]! + condensed[i]!;
    }
  }
  const localExternal = new Float64Array(6);
  for (let i = 0; i < 6; i++) localExternal[i] = -condensed[i]!;
  const globalExternal = localToGlobalVector(localExternal, element.cos, element.sin);
  const dofs = elementDofs(element);
  for (let i = 0; i < 6; i++) {
    const dof = dofs[i]!;
    global[dof] = global[dof]! + globalExternal[i]!;
  }
}

/** Fixed-end force vector for a uniform local load (positive local x/y). */
function uniformFixedEnd(px: number, py: number, L: number): Float64Array {
  const fixedEnd = new Float64Array(6);
  fixedEnd[0] = (-px * L) / 2;
  fixedEnd[3] = (-px * L) / 2;
  fixedEnd[1] = (-py * L) / 2;
  fixedEnd[2] = (-py * L * L) / 12;
  fixedEnd[4] = (-py * L) / 2;
  fixedEnd[5] = (py * L * L) / 12;
  return fixedEnd;
}

/** Fixed-end force vector for a local point load using Hermite shape functions. */
function pointFixedEnd(px: number, py: number, xi: number, L: number): Float64Array {
  const oneMinusXi = 1 - xi;
  const fixedEnd = new Float64Array(6);
  fixedEnd[0] = -px * oneMinusXi;
  fixedEnd[3] = -px * xi;
  fixedEnd[1] = -py * (1 - 3 * xi ** 2 + 2 * xi ** 3);
  fixedEnd[2] = -py * L * (xi - 2 * xi ** 2 + xi ** 3);
  fixedEnd[4] = -py * (3 * xi ** 2 - 2 * xi ** 3);
  fixedEnd[5] = -py * L * (-(xi ** 2) + xi ** 3);
  return fixedEnd;
}

function localToGlobalVector(local: Float64Array, cos: number, sin: number): Float64Array {
  const global = new Float64Array(6);
  for (const offset of [0, 3]) {
    const u = local[offset]!;
    const v = local[offset + 1]!;
    global[offset] = cos * u - sin * v;
    global[offset + 1] = sin * u + cos * v;
    global[offset + 2] = local[offset + 2]!;
  }
  return global;
}
