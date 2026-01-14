/**
 * Worker boundary for modal and buckling solves.
 * No dependency wrapper: typed arrays cross the structured-clone boundary.
 */
import { buckling, modal } from '../fem/eigen';
import type { AnalysisMesh, EigenResult } from '../fem/types';

export interface EigenWorkerRequest {
  id: number;
  mesh: AnalysisMesh;
  elementN: Float64Array;
  nModes: number;
}

export type EigenWorkerResponse =
  | { id: number; ok: true; modal: EigenResult; buckling: EigenResult }
  | { id: number; ok: false; message: string };

interface EigenWorkerScope {
  onmessage: (event: MessageEvent<EigenWorkerRequest>) => void;
  postMessage: (message: EigenWorkerResponse) => void;
}

const worker = self as unknown as EigenWorkerScope;

worker.onmessage = (event: MessageEvent<EigenWorkerRequest>) => {
  const { id, mesh, elementN, nModes } = event.data;
  try {
    const modalResult = modal(mesh, nModes);
    const bucklingResult = buckling(mesh, elementN);
    const response: EigenWorkerResponse = { id, ok: true, modal: modalResult, buckling: bucklingResult };
    worker.postMessage(response);
  } catch (error) {
    worker.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : 'Eigenanalysis could not run.',
    } satisfies EigenWorkerResponse);
  }
};
