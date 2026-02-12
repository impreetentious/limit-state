/**
 * Worker boundary for modal and buckling solves. docs/FEM-SPEC.md §3 and §4.5.
 * No dependency wrapper: large typed arrays cross the worker boundary by transfer.
 */
import { buckling, modal } from '../fem/eigen';
import { buckling3d, modal3d } from '../fem/space';
import type { AnalysisMesh3d } from '../fem/space';
import type { AnalysisMesh, EigenResult } from '../fem/types';

export interface EigenWorkerRequest2d {
  id: number;
  dimension: '2d';
  mesh: AnalysisMesh;
  elementN: Float64Array;
  nModes: number;
}

export interface EigenWorkerRequest3d {
  id: number;
  dimension: '3d';
  mesh: AnalysisMesh3d;
  elementN: Float64Array;
  nModes: number;
}

export type EigenWorkerRequest = EigenWorkerRequest2d | EigenWorkerRequest3d;

export type EigenWorkerResponse =
  | { id: number; ok: true; modal: EigenResult; buckling: EigenResult }
  | { id: number; ok: false; message: string };

interface EigenWorkerScope {
  onmessage: (event: MessageEvent<EigenWorkerRequest>) => void;
  postMessage: (message: EigenWorkerResponse, transfer?: Transferable[]) => void;
}

const worker = self as unknown as EigenWorkerScope;

worker.onmessage = (event: MessageEvent<EigenWorkerRequest>) => {
  const { id, mesh, elementN, nModes } = event.data;
  try {
    const modalResult =
      event.data.dimension === '3d'
        ? modal3d(mesh as AnalysisMesh3d, nModes)
        : modal(mesh as AnalysisMesh, nModes);
    const bucklingResult =
      event.data.dimension === '3d'
        ? buckling3d(mesh as AnalysisMesh3d, elementN)
        : buckling(mesh as AnalysisMesh, elementN);
    const response: EigenWorkerResponse = {
      id,
      ok: true,
      modal: modalResult,
      buckling: bucklingResult,
    };
    worker.postMessage(response, [
      response.modal.values.buffer,
      response.modal.vectors.buffer,
      response.buckling.values.buffer,
      response.buckling.vectors.buffer,
    ]);
  } catch (error) {
    worker.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : 'Eigenanalysis could not run.',
    } satisfies EigenWorkerResponse);
  }
};
