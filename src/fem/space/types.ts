/**
 * Phase 3 space-frame types. Parallel to the 2D editor model; schema v2
 * migration lands with the 3D editor.
 */

export interface NodeSpec3d {
  id: number;
  x: number;
  y: number;
  z: number;
}

export type SupportKind3d = 'pin' | 'rollerX' | 'rollerY' | 'rollerZ' | 'fixed';

export interface SupportSpec3d {
  node: number;
  kind: SupportKind3d;
}

/** End releases for the three rotational DOFs. */
export interface EndReleases3d {
  tx: boolean; // θx (torsion)
  ty: boolean; // θy
  tz: boolean; // θz
}

export interface MemberSpec3d {
  id: number;
  a: number;
  b: number;
  material: import('../types').MaterialId;
  section: import('../types').SectionSpec;
  releaseA: EndReleases3d;
  releaseB: EndReleases3d;
  /** Roll angle (rad) about local x after the default triad. */
  roll: number;
  /** Tension-only cable — slack iteration in `cables3d`. */
  cableOnly?: boolean;
}

export interface PointLoad3d {
  node: number;
  fx: number;
  fy: number;
  fz: number;
  mx?: number;
  my?: number;
  mz?: number;
}

export interface EditorModel3d {
  v: 2;
  name: string;
  seed: number;
  nodes: NodeSpec3d[];
  members: MemberSpec3d[];
  supports: SupportSpec3d[];
  loads: { gravity: boolean; points: PointLoad3d[] };
  /** Contiguous member-id path for traffic (3D polyline). */
  deck?: number[];
  /**
   * Phase 3 stories. Wind carries a horizontal direction dial; traffic rides
   * the deck polyline.
   */
  story?: StorySpec3d;
}

/** 3D story specs. */
export type StorySpec3d =
  | {
      kind: 'wind';
      pattern: 'steady' | 'sine' | 'gusts';
      amplitudekNm: number;
      freqHz: number;
      zeta: number;
      /** Horizontal azimuth in degrees: 0 = +X, 90 = +Y. */
      directionDeg: number;
    }
  | {
      kind: 'traffic';
      weightkN: number;
      speed: number;
      /** Optional moving-mass Newmark (2H cousin). */
      movingMass: boolean;
    }
  | { kind: 'ramp' }
  | { kind: 'pushover' }
  | {
      kind: 'earthquake';
      record: import('../types').EarthquakeRecordId;
      scale: number;
      zeta: number;
    };

export interface Element3d {
  memberId: number;
  na: number;
  nb: number;
  E: number;
  G: number;
  A: number;
  Iy: number;
  Iz: number;
  J: number;
  /** Extreme fiber distance for Iz bending (section depth/2). */
  c?: number;
  fy?: number;
  rho: number;
  L: number;
  /** Rows of R: local basis expressed in global coords. Length 9, row-major. */
  R: Float64Array;
  releaseA: EndReleases3d;
  releaseB: EndReleases3d;
}

export interface AnalysisMesh3d {
  /** [x0,y0,z0, x1,y1,z1, …]; DOFs of node i are [6i … 6i+5]. */
  coords: Float64Array;
  elements: Element3d[];
  editorNode: Int32Array;
  freeDofs: Int32Array;
  ndof: number;
}

export interface StaticResult3d {
  u: Float64Array;
  /** per element local end forces [Fx,Fy,Fz,Mx,My,Mz]×2 */
  elementForces: Float64Array;
  /** per editor member: max combined-stress utilization */
  utilization: Map<number, number>;
  reactions: Map<number, { fx: number; fy: number; fz: number; mx: number; my: number; mz: number }>;
}

export const NO_RELEASES: EndReleases3d = { tx: false, ty: false, tz: false };
export const TRUSS_RELEASES: EndReleases3d = { tx: true, ty: true, tz: true };
