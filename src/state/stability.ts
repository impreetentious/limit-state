import { assembleK } from '../fem/assemble';
import { buildMesh } from '../fem/mesh';
import { factorLDLT, freeMatrix, mechanismEditorNode } from '../fem/solve';
import type { AnalysisOptions, EditorModel } from '../fem/types';
import type { Stability } from './editor-store';

/** Live stability lint used by the editor after its 300 ms debounce. */
export function inspectStability(model: EditorModel, options: AnalysisOptions = {}): Stability {
  if (model.members.length === 0) return { kind: 'idle', message: 'Draw members and add supports to check stability.' };
  try {
    const mesh = buildMesh(model, options);
    const factor = factorLDLT(freeMatrix(assembleK(mesh), mesh.ndof, mesh.freeDofs), mesh.freeDofs.length);
    if (factor.ok) return { kind: 'stable', message: 'Stable under the current supports.' };
    const nodeId = mechanismEditorNode(mesh, factor.mechanism.freeDofIndex);
    return {
      kind: 'mechanism',
      nodeId,
      message: `Node ${nodeId} can move freely — add a support or member.`,
    };
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : 'Model validation failed.' };
  }
}
