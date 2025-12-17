/**
 * Single source of truth for the model and result types.
 * Serialization schema v1 mirrors EditorModel exactly.
 * Everything in fem/ is pure and DOM-free.
 */

// ---------- editor model (what the user draws; serialized to the URL) ----------

export interface NodeSpec {
  id: number;
  x: number; // m
  y: number; // m
}

export type SectionSpec =
  | { kind: 'rect'; b: number; h: number }
  | { kind: 'box'; b: number; h: number; t: number }
  | { kind: 'ibeam'; b: number; h: number; tf: number; tw: number }
  | { kind: 'tube'; d: number; t: number };

export interface MemberSpec {
  id: number;
  a: number; // node id
  b: number; // node id
  material: MaterialId;
  section: SectionSpec;
  releaseA: boolean; // moment release at end a (truss/hinge)
  releaseB: boolean;
}

export type SupportKind = 'pin' | 'roller' | 'fixed';

export interface SupportSpec {
  node: number;
  kind: SupportKind;
}

export interface PointLoad {
  node: number;
  fx: number; // N
  fy: number; // N
}

export type StorySpec =
  | { kind: 'traffic'; weightkN: number; speed: number }
  | { kind: 'wind'; pattern: 'steady' | 'sine' | 'gusts'; amplitudekNm: number; freqHz: number; zeta: number }
  | { kind: 'ramp' };

export interface EditorModel {
  v: 1;
  name: string;
  seed: number;
  nodes: NodeSpec[];
  members: MemberSpec[];
  supports: SupportSpec[];
  loads: { gravity: boolean; points: PointLoad[] };
  deck: number[]; // member ids forming the traffic path, in order
  story: StorySpec;
}

export type MaterialId = 'steel-s355' | 'alu-6061' | 'timber' | 'spaghetti';

export interface Material {
  id: MaterialId;
  label: string;
  E: number; // Pa
  fy: number; // Pa
  rho: number; // kg/m^3
}

export interface SectionProps {
  A: number; // m^2
  I: number; // m^4
  c: number; // extreme fiber distance, m
}

// ---------- analysis mesh (members auto-split into 2 elements) ----------

export interface Element {
  memberId: number; // owning editor member
  na: number; // mesh node indices (not editor ids)
  nb: number;
  E: number;
  A: number;
  I: number;
  c: number;
  rho: number;
  fy: number;
  L: number;
  cos: number;
  sin: number;
  releaseA: boolean;
  releaseB: boolean;
}

export interface AnalysisMesh {
  /** mesh node coords, [x0,y0,x1,y1,...]; DOFs of node i are [3i, 3i+1, 3i+2] */
  coords: Float64Array;
  elements: Element[];
  /** mesh node index -> editor node id (mid-nodes: -1) */
  editorNode: Int32Array;
  /** sorted free DOF indices after applying supports */
  freeDofs: Int32Array;
  ndof: number;
}

// ---------- results ----------

export interface StaticResult {
  /** full-length displacement vector (constrained entries zero) */
  u: Float64Array;
  /** per element: [N, Va, Ma, Vb, Mb] in local axes, tension-positive N */
  elementForces: Float64Array;
  /** per editor member: max combined-stress utilization */
  utilization: Map<number, number>;
  reactions: Map<number, { fx: number; fy: number; m: number }>;
}

export interface EigenResult {
  kind: 'modal' | 'buckling';
  /** modal: omega_i rad/s. buckling: single lambda_cr (values[0]); rest are higher factors */
  values: Float64Array;
  /** mass-normalized mode shapes, column-major [ndof x nmodes] */
  vectors: Float64Array;
  iterations: number;
}

export type FailureReport =
  | { kind: 'mechanism'; nodeId: number }
  | { kind: 'yield'; memberId: number; utilization: number; loadFactor: number }
  | {
      kind: 'buckling';
      governs: 'global' | 'member';
      memberId: number;
      lambdaCr: number;
      memberN?: number;
      memberNCr?: number;
    }
  | { kind: 'resonance'; mode: number; freqHz: number; daf: number; consequence?: 'yield' }
  | { kind: 'stable'; capacityFactor: number; governedBy: 'yield' | 'buckling'; memberId: number };

export interface CascadeStep {
  action: 'hinge' | 'remove';
  memberId: number;
  detail: string; // human sentence for the timeline
}

export interface CascadeResult {
  steps: CascadeStep[];
  outcome: 'stable' | 'collapse';
}
