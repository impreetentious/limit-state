/**
 * 12-DOF space-frame element matrices and assembly.
 * Local DOF order: [u, v, w, θx, θy, θz] × 2.
 */
import { createSkyline, profileFromDofGroups, skylineAdd, skylineToDense, type SkylineMatrix } from '../skyline';
import type { AnalysisMesh3d, Element3d, EndReleases3d } from './types';

const N = 12;

/**
 * Local space-frame stiffness.
 * Axial EA/L, torsion GJ/L, bending about z (I_z) and about y (I_y with RH sign flip).
 */
export function kLocal3d(E: number, G: number, A: number, Iy: number, Iz: number, J: number, L: number): Float64Array {
  const k = new Float64Array(N * N);
  const a = (E * A) / L;
  const t = (G * J) / L;
  const by = (E * Iy) / (L * L * L);
  const bz = (E * Iz) / (L * L * L);
  const set = (i: number, j: number, v: number) => {
    k[i * N + j] = v;
    if (i !== j) k[j * N + i] = v;
  };

  // Axial
  set(0, 0, a);
  set(6, 6, a);
  set(0, 6, -a);

  // Torsion
  set(3, 3, t);
  set(9, 9, t);
  set(3, 9, -t);

  // Bending about z — [v1, θz1, v2, θz2] = [1, 5, 7, 11].
  set(1, 1, 12 * bz);
  set(7, 7, 12 * bz);
  set(1, 7, -12 * bz);
  set(1, 5, 6 * bz * L);
  set(1, 11, 6 * bz * L);
  set(5, 7, -6 * bz * L);
  set(7, 11, -6 * bz * L);
  set(5, 5, 4 * bz * L * L);
  set(11, 11, 4 * bz * L * L);
  set(5, 11, 2 * bz * L * L);

  // Bending about y — [w1, θy1, w2, θy2] = [2, 4, 8, 10], RH sign flip.
  set(2, 2, 12 * by);
  set(8, 8, 12 * by);
  set(2, 8, -12 * by);
  set(2, 4, -6 * by * L);
  set(2, 10, -6 * by * L);
  set(4, 8, 6 * by * L);
  set(8, 10, 6 * by * L);
  set(4, 4, 4 * by * L * L);
  set(10, 10, 4 * by * L * L);
  set(4, 10, 2 * by * L * L);

  return k;
}

/**
 * Consistent geometric stiffness, 12×12. Axial force tension-positive.
 * Same 4×4 block as §4.1 on each bending plane (Cook ch. 9 analogue).
 */
export function kgLocal3d(axialN: number, L: number): Float64Array {
  const g = new Float64Array(N * N);
  const c = axialN / L;
  const block = [
    [6 / 5, L / 10, -6 / 5, L / 10],
    [L / 10, (2 * L * L) / 15, -L / 10, (-L * L) / 30],
    [-6 / 5, -L / 10, 6 / 5, -L / 10],
    [L / 10, (-L * L) / 30, -L / 10, (2 * L * L) / 15],
  ];
  // [v, θz, v, θz] = [1, 5, 7, 11] — identical to 2D kgLocal.
  const iz = [1, 5, 7, 11];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) g[iz[i]! * N + iz[j]!] = c * block[i]![j]!;

  // [w, θy, w, θy] = [2, 4, 8, 10] — RH sign flip on L-linear couplings (mirror k_y).
  const iy = [2, 4, 8, 10];
  const blockY = [
    [6 / 5, -L / 10, -6 / 5, -L / 10],
    [-L / 10, (2 * L * L) / 15, L / 10, (-L * L) / 30],
    [-6 / 5, L / 10, 6 / 5, L / 10],
    [-L / 10, (-L * L) / 30, L / 10, (2 * L * L) / 15],
  ];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) g[iy[i]! * N + iy[j]!] = c * blockY[i]![j]!;

  return g;
}

/**
 * Consistent mass, 12×12. Axial + St. Venant rotary (Ip = Iy+Iz) + two Hermite bending blocks.
 */
export function mLocal3d(rho: number, A: number, Iy: number, Iz: number, L: number): Float64Array {
  const m = new Float64Array(N * N);
  const ax = (rho * A * L) / 6;
  m[0] = 2 * ax;
  m[6 * N + 6] = 2 * ax;
  m[6] = ax;
  m[6 * N] = ax;

  const Ip = Iy + Iz;
  const rt = (rho * Ip * L) / 6;
  m[3 * N + 3] = 2 * rt;
  m[9 * N + 9] = 2 * rt;
  m[3 * N + 9] = rt;
  m[9 * N + 3] = rt;

  const c = (rho * A * L) / 420;
  const bend = [
    [156, 22 * L, 54, -13 * L],
    [22 * L, 4 * L * L, 13 * L, -3 * L * L],
    [54, 13 * L, 156, -22 * L],
    [-13 * L, -3 * L * L, -22 * L, 4 * L * L],
  ];
  const iz = [1, 5, 7, 11];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) m[iz[i]! * N + iz[j]!] = c * bend[i]![j]!;

  // RH for θy: flip signs on terms odd in L (w–θ couplings).
  const bendY = [
    [156, -22 * L, 54, 13 * L],
    [-22 * L, 4 * L * L, -13 * L, -3 * L * L],
    [54, -13 * L, 156, 22 * L],
    [13 * L, -3 * L * L, 22 * L, 4 * L * L],
  ];
  const iy = [2, 4, 8, 10];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) m[iy[i]! * N + iy[j]!] = c * bendY[i]![j]!;

  return m;
}

/**
 * Build the local triad (e_x, e_y, e_z) as a row-major 3×3 R.
 * Prefer global Z as reference; fall back to global Y when nearly parallel.
 */
export function memberTriad(dx: number, dy: number, dz: number, roll = 0): Float64Array {
  const L = Math.hypot(dx, dy, dz);
  if (!(L > 0)) throw new Error('Member length must be positive.');
  const exx = dx / L;
  const exy = dy / L;
  const exz = dz / L;

  let rx: number, ry: number, rz: number;
  if (Math.abs(exz) > 0.9) {
    // Nearly vertical — reference = global Y.
    rx = 0;
    ry = 1;
    rz = 0;
  } else {
    rx = 0;
    ry = 0;
    rz = 1;
  }

  // ey = normalize(ref × ex) so ez = ex × ey completes the right-handed triad.
  let eyx = ry * exz - rz * exy;
  let eyy = rz * exx - rx * exz;
  let eyz = rx * exy - ry * exx;
  let eyLen = Math.hypot(eyx, eyy, eyz);
  if (!(eyLen > 0)) {
    // Degenerate fallback.
    rx = 1;
    ry = 0;
    rz = 0;
    eyx = ry * exz - rz * exy;
    eyy = rz * exx - rx * exz;
    eyz = rx * exy - ry * exx;
    eyLen = Math.hypot(eyx, eyy, eyz);
  }
  eyx /= eyLen;
  eyy /= eyLen;
  eyz /= eyLen;

  let ezx = exy * eyz - exz * eyy;
  let ezy = exz * eyx - exx * eyz;
  let ezz = exx * eyy - exy * eyx;

  if (roll !== 0) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const yx = c * eyx + s * ezx;
    const yy = c * eyy + s * ezy;
    const yz = c * eyz + s * ezz;
    const zx = -s * eyx + c * ezx;
    const zy = -s * eyy + c * ezy;
    const zz = -s * eyz + c * ezz;
    eyx = yx;
    eyy = yy;
    eyz = yz;
    ezx = zx;
    ezy = zy;
    ezz = zz;
  }

  return Float64Array.of(exx, exy, exz, eyx, eyy, eyz, ezx, ezy, ezz);
}

/** K_global = Tᵀ k T with T = blockdiag(R,R,R,R). */
export function transformToGlobal3d(kLoc: Float64Array, R: Float64Array): Float64Array {
  // t = kLoc * T, then out = Tᵀ * t. Each 3-block multiplies by R.
  const t = new Float64Array(N * N);
  const out = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let blk = 0; blk < 4; blk++) {
      const o = blk * 3;
      const a = kLoc[i * N + o]!;
      const b = kLoc[i * N + o + 1]!;
      const c = kLoc[i * N + o + 2]!;
      // Column transform: local = R * global ⇒ multiply columns by Rᵀ… wait:
      // d_local = T d_global with T = blkdiag(R,…), so K_g = Tᵀ K_l T.
      // First form t = K_l T: each 3-col block of t = K_l_block * R.
      t[i * N + o] = a * R[0]! + b * R[3]! + c * R[6]!;
      t[i * N + o + 1] = a * R[1]! + b * R[4]! + c * R[7]!;
      t[i * N + o + 2] = a * R[2]! + b * R[5]! + c * R[8]!;
    }
  }
  for (let j = 0; j < N; j++) {
    for (let blk = 0; blk < 4; blk++) {
      const o = blk * 3;
      const a = t[o * N + j]!;
      const b = t[(o + 1) * N + j]!;
      const c = t[(o + 2) * N + j]!;
      // out = Tᵀ t ⇒ each 3-row block = Rᵀ * t_block.
      out[o * N + j] = R[0]! * a + R[3]! * b + R[6]! * c;
      out[(o + 1) * N + j] = R[1]! * a + R[4]! * b + R[7]! * c;
      out[(o + 2) * N + j] = R[2]! * a + R[5]! * b + R[8]! * c;
    }
  }
  return out;
}

/** Local element stiffness after rotational end-release condensation. */
export function elementLocalStiffness3d(element: Element3d): Float64Array {
  const elastic = kLocal3d(element.E, element.G, element.A, element.Iy, element.Iz, element.J, element.L);
  return condenseWithElementReleases(elastic, element);
}

/** Assemble global K (symmetric skyline). */
export function assembleK3d(mesh: AnalysisMesh3d): SkylineMatrix {
  const groups = mesh.elements.map((element) => [...elementDofs3d(element)]);
  const K = createSkyline(profileFromDofGroups(mesh.ndof, groups));
  for (const element of mesh.elements) {
    const local = elementLocalStiffness3d(element);
    addElementMatrixSkyline3d(K, transformToGlobal3d(local, element.R), element);
  }
  return K;
}

/** Dense K for eigen / Newmark bridges that still expect Float64Array. */
export function assembleK3dDense(mesh: AnalysisMesh3d): Float64Array {
  return skylineToDense(assembleK3d(mesh));
}

/** Assemble global consistent M. */
export function assembleM3d(mesh: AnalysisMesh3d): Float64Array {
  const M = new Float64Array(mesh.ndof * mesh.ndof);
  for (const element of mesh.elements) {
    const local = condenseWithElementReleases(
      mLocal3d(element.rho, element.A, element.Iy, element.Iz, element.L),
      element,
    );
    addElementMatrix3d(M, mesh.ndof, transformToGlobal3d(local, element.R), element);
  }
  return M;
}

/** Assemble K_g from tension-positive local axial forces. */
export function assembleKg3d(mesh: AnalysisMesh3d, elementN: Float64Array): Float64Array {
  if (elementN.length !== mesh.elements.length) {
    throw new Error('Geometric stiffness requires exactly one axial force per analysis element.');
  }
  const Kg = new Float64Array(mesh.ndof * mesh.ndof);
  for (let index = 0; index < mesh.elements.length; index++) {
    const element = mesh.elements[index]!;
    const local = condenseWithElementReleases(kgLocal3d(elementN[index]!, element.L), element);
    addElementMatrix3d(Kg, mesh.ndof, transformToGlobal3d(local, element.R), element);
  }
  return Kg;
}

export interface LoadAssembly3d {
  F: Float64Array;
  /** Local fixed-end forces, 12 per element — subtracted in stress recovery. */
  elementFixedEnd: Float64Array;
}

/** Nodal point loads (forces + optional moments) into the global vector. */
export function assembleF3d(
  mesh: AnalysisMesh3d,
  points: { meshNode: number; fx: number; fy: number; fz: number; mx?: number; my?: number; mz?: number }[],
): LoadAssembly3d {
  return assembleLoadCase3d(mesh, { points });
}

/**
 * Nodal + in-element (Hermite) loads for 3D traffic.
 * `inElement` forces are global (fx,fy,fz); typically (0,0,−axleWeight) for gravity.
 */
export function assembleLoadCase3d(
  mesh: AnalysisMesh3d,
  opts: {
    points?: { meshNode: number; fx: number; fy: number; fz: number; mx?: number; my?: number; mz?: number }[];
    inElement?: { element: number; xi: number; fx: number; fy: number; fz: number }[];
  },
): LoadAssembly3d {
  const F = new Float64Array(mesh.ndof);
  const elementFixedEnd = new Float64Array(mesh.elements.length * 12);

  for (const point of opts.points ?? []) {
    if (!Number.isInteger(point.meshNode) || point.meshNode < 0 || point.meshNode * 6 >= mesh.ndof) {
      throw new Error(`Point load references missing mesh node ${point.meshNode}.`);
    }
    const base = 6 * point.meshNode;
    F[base] = F[base]! + point.fx;
    F[base + 1] = F[base + 1]! + point.fy;
    F[base + 2] = F[base + 2]! + point.fz;
    if (point.mx) F[base + 3] = F[base + 3]! + point.mx;
    if (point.my) F[base + 4] = F[base + 4]! + point.my;
    if (point.mz) F[base + 5] = F[base + 5]! + point.mz;
  }

  for (const axle of opts.inElement ?? []) {
    const element = mesh.elements[axle.element];
    if (!element) throw new Error(`In-element load references missing element ${axle.element}.`);
    if (!(axle.xi >= 0 && axle.xi <= 1)) throw new Error('In-element load position xi must be within [0, 1].');
    const R = element.R;
    // local = R · global
    const px = R[0]! * axle.fx + R[1]! * axle.fy + R[2]! * axle.fz;
    const py = R[3]! * axle.fx + R[4]! * axle.fy + R[5]! * axle.fz;
    const pz = R[6]! * axle.fx + R[7]! * axle.fy + R[8]! * axle.fz;
    addEquivalentLocalLoad3d(F, mesh, axle.element, pointFixedEnd3d(px, py, pz, axle.xi, element.L), elementFixedEnd);
  }

  return { F, elementFixedEnd };
}

/**
 * Hermite fixed-end for a local point force at ξ.
 * v/θz block matches 2D; w/θy uses the RH moment sign flip of k_y.
 */
export function pointFixedEnd3d(px: number, py: number, pz: number, xi: number, L: number): Float64Array {
  const oneMinusXi = 1 - xi;
  const n1 = 1 - 3 * xi ** 2 + 2 * xi ** 3;
  const n2 = xi - 2 * xi ** 2 + xi ** 3;
  const n3 = 3 * xi ** 2 - 2 * xi ** 3;
  const n4 = -(xi ** 2) + xi ** 3;
  const f = new Float64Array(12);
  f[0] = -px * oneMinusXi;
  f[6] = -px * xi;
  f[1] = -py * n1;
  f[5] = -py * L * n2;
  f[7] = -py * n3;
  f[11] = -py * L * n4;
  f[2] = -pz * n1;
  f[4] = pz * L * n2; // RH flip vs θz
  f[8] = -pz * n3;
  f[10] = pz * L * n4;
  return f;
}

function addEquivalentLocalLoad3d(
  global: Float64Array,
  mesh: AnalysisMesh3d,
  elementIndex: number,
  fixedEnd: Float64Array,
  fixedEndByElement: Float64Array,
): void {
  const element = mesh.elements[elementIndex]!;
  for (let i = 0; i < 12; i++) {
    const offset = elementIndex * 12 + i;
    fixedEndByElement[offset] = fixedEndByElement[offset]! + fixedEnd[i]!;
  }
  // Applied nodal loads = −Tᵀ f_fixed (T = blkdiag(R,…)).
  const R = element.R;
  const dofs = elementDofs3d(element);
  for (let blk = 0; blk < 4; blk++) {
    const o = blk * 3;
    const lx = -fixedEnd[o]!;
    const ly = -fixedEnd[o + 1]!;
    const lz = -fixedEnd[o + 2]!;
    // global = Rᵀ · local
    global[dofs[o]!] = global[dofs[o]!]! + R[0]! * lx + R[3]! * ly + R[6]! * lz;
    global[dofs[o + 1]!] = global[dofs[o + 1]!]! + R[1]! * lx + R[4]! * ly + R[7]! * lz;
    global[dofs[o + 2]!] = global[dofs[o + 2]!]! + R[2]! * lx + R[5]! * ly + R[8]! * lz;
  }
}

function addElementMatrix3d(global: Float64Array, ndof: number, local: Float64Array, element: Element3d): void {
  const dofs = elementDofs3d(element);
  for (let i = 0; i < N; i++) {
    const row = dofs[i]!;
    for (let j = 0; j < N; j++) {
      const index = row * ndof + dofs[j]!;
      global[index] = global[index]! + local[i * N + j]!;
    }
  }
}

/** Scatter a 12×12 into the symmetric skyline (lower triangle only). */
function addElementMatrixSkyline3d(global: SkylineMatrix, local: Float64Array, element: Element3d): void {
  const dofs = elementDofs3d(element);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j <= i; j++) {
      // Average the symmetric pair to guard tiny antisymmetry from transforms.
      const v = 0.5 * (local[i * N + j]! + local[j * N + i]!);
      if (v !== 0) skylineAdd(global, dofs[i]!, dofs[j]!, v);
    }
  }
}

function elementDofs3d(element: Element3d): readonly number[] {
  const a = 6 * element.na;
  const b = 6 * element.nb;
  return [a, a + 1, a + 2, a + 3, a + 4, a + 5, b, b + 1, b + 2, b + 3, b + 4, b + 5];
}

function releasedRotations3d(element: Element3d): number[] {
  const out: number[] = [];
  pushReleases(out, 0, element.releaseA);
  pushReleases(out, 6, element.releaseB);
  return out;
}

function pushReleases(out: number[], base: number, r: EndReleases3d): void {
  if (r.tx) out.push(base + 3);
  if (r.ty) out.push(base + 4);
  if (r.tz) out.push(base + 5);
}

/**
 * Static condensation of released rotational DOFs using the element's elastic
 * release transform (Cᵀ A C).
 */
function condenseWithElementReleases(matrix: Float64Array, element: Element3d): Float64Array {
  const released = releasedRotations3d(element);
  if (released.length === 0) return matrix;
  const elastic = kLocal3d(element.E, element.G, element.A, element.Iy, element.Iz, element.J, element.L);
  const transform = releaseTransform3d(elastic, released);
  const condensed = new Float64Array(N * N);
  for (let row = 0; row < N; row++) {
    for (let column = 0; column < N; column++) {
      let value = 0;
      for (let i = 0; i < N; i++) {
        const left = transform[i * N + row]!;
        if (left === 0) continue;
        for (let j = 0; j < N; j++) value += left * matrix[i * N + j]! * transform[j * N + column]!;
      }
      condensed[row * N + column] = value;
    }
  }
  return condensed;
}

function releaseTransform3d(k: Float64Array, released: number[]): Float64Array {
  const transform = new Float64Array(N * N);
  const kept = Array.from({ length: N }, (_, i) => i).filter((d) => !released.includes(d));
  for (const dof of kept) transform[dof * N + dof] = 1;

  const nr = released.length;
  const rr = new Float64Array(nr * nr);
  const rk = new Float64Array(nr * kept.length);
  for (let i = 0; i < nr; i++) {
    for (let j = 0; j < nr; j++) rr[i * nr + j] = k[released[i]! * N + released[j]!]!;
    for (let j = 0; j < kept.length; j++) rk[i * kept.length + j] = k[released[i]! * N + kept[j]!]!;
  }

  // Invert rr (small; nr ≤ 6) via Gauss-Jordan.
  const inv = invertSmall(rr, nr);
  // C_r,* for kept columns: −rr⁻¹ rk
  for (let i = 0; i < nr; i++) {
    for (let j = 0; j < kept.length; j++) {
      let value = 0;
      for (let p = 0; p < nr; p++) value -= inv[i * nr + p]! * rk[p * kept.length + j]!;
      transform[released[i]! * N + kept[j]!] = value;
    }
  }
  return transform;
}

function invertSmall(a: Float64Array, n: number): Float64Array {
  const m = new Float64Array(n * 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i * 2 * n + j] = a[i * n + j]!;
    m[i * 2 * n + n + i] = 1;
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row * 2 * n + col]!) > Math.abs(m[pivot * 2 * n + col]!)) pivot = row;
    }
    if (pivot !== col) {
      for (let j = 0; j < 2 * n; j++) {
        const tmp = m[col * 2 * n + j]!;
        m[col * 2 * n + j] = m[pivot * 2 * n + j]!;
        m[pivot * 2 * n + j] = tmp;
      }
    }
    const diag = m[col * 2 * n + col]!;
    if (!(Math.abs(diag) > 0)) throw new Error('Released rotation block is singular.');
    for (let j = 0; j < 2 * n; j++) m[col * 2 * n + j] = m[col * 2 * n + j]! / diag;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row * 2 * n + col]!;
      for (let j = 0; j < 2 * n; j++) m[row * 2 * n + j] = m[row * 2 * n + j]! - factor * m[col * 2 * n + j]!;
    }
  }
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) inv[i * n + j] = m[i * 2 * n + n + j]!;
  return inv;
}
