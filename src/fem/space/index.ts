/** Space-frame application surface. docs/FEM-SPEC.md §4.9 / §14. */
export {
  kLocal3d,
  kgLocal3d,
  mLocal3d,
  memberTriad,
  transformToGlobal3d,
  assembleK3d,
  assembleK3dDense,
  assembleM3d,
  assembleF3d,
} from './assemble';
export { buildMesh3d } from './mesh';
export {
  analyzeStaticModel3d,
  prepareStaticSystem3d,
  solveStatic3d,
  strainEnergy3d,
  externalWork3d,
  deformationDisplay3d,
} from './statics';
export { buckling3d, modal3d } from './eigen';
export { solveSecondOrderStatic3d } from './second-order';
export type { StaticAnalysis3d } from './statics';
export type {
  AnalysisMesh3d,
  EditorModel3d,
  Element3d,
  EndReleases3d,
  MemberSpec3d,
  NodeSpec3d,
  StorySpec3d,
  SupportKind3d,
  SupportSpec3d,
} from './types';
export { NO_RELEASES } from './types';
