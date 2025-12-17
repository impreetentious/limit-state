/**
 * EditorModel -> AnalysisMesh: subdivide each member into 2 elements (mid-node),
 * number DOFs, apply supports to the free-DOF list, validate deck contiguity.
 * M1.
 */
import type { AnalysisMesh, EditorModel } from './types';

export function buildMesh(_model: EditorModel): AnalysisMesh {
  throw new Error('TODO(M1): mesh (2 sub-elements per member, hidden)');
}
