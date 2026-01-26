/** Phase 3 space-frame public surface. */
export {
  kLocal3d,
  kgLocal3d,
  mLocal3d,
  memberTriad,
  transformToGlobal3d,
  assembleK3d,
  assembleKg3d,
  assembleM3d,
  assembleF3d,
  assembleLoadCase3d,
  pointFixedEnd3d,
  elementLocalStiffness3d,
} from './assemble';
export { buildMesh3d, planarCantileverModel } from './mesh';
export {
  analyzeStaticModel3d,
  prepareStaticSystem3d,
  solveStatic3d,
  strainEnergy3d,
  externalWork3d,
  deformationDisplay3d,
  elementForcesAtDisplacement3d,
  utilizationAtDisplacement3d,
} from './statics';
export { buckling3d, modal3d } from './eigen';
export {
  buildDeckRoute3d,
  mapDeckStation3d,
  editorNodeIndex3d,
  deckLength3d,
} from './deck';
export type { StaticAnalysis3d, StaticSystem3d } from './statics';
export type { DeckSegment3d, DeckStationHit3d } from './deck';
export type {
  AnalysisMesh3d,
  EditorModel3d,
  Element3d,
  EndReleases3d,
  MemberSpec3d,
  NodeSpec3d,
  PointLoad3d,
  StaticResult3d,
  StorySpec3d,
  SupportKind3d,
  SupportSpec3d,
} from './types';
export { NO_RELEASES, TRUSS_RELEASES } from './types';
