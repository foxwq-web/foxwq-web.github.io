import type { EstimateResponse, Estimator } from './score-estimation.ts';

import { UNSUPPORTED_ESTIMATOR, ESTIMATOR_LOAD_ERROR } from './fox-score-errors.ts';
export { UNSUPPORTED_ESTIMATOR, ESTIMATOR_LOAD_ERROR } from './fox-score-errors.ts';

export function supportsLocalEstimate() {
  return typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function' &&
    typeof Worker === 'function';
}

export type EstimatorMessage = { result: EstimateResponse } | { error: string };
export type EstimatorRequest = string | { status: string; module: WebAssembly.Module };
export interface EstimatorWorker {
  onmessage: ((event: MessageEvent<EstimatorMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: EstimatorRequest): void;
  terminate(): void;
}



export function estimateInWorker(status: string, signal: AbortSignal,
  createWorker: () => EstimatorWorker, module?: WebAssembly.Module | Promise<WebAssembly.Module>) {
  // Shared preloading can finish after cancellation or a worker startup failure.
  if (module) void Promise.resolve(module).catch(() => {});
  if (!/^[012]{361}$/.test(status)) return Promise.reject(Error('Invalid board'));
  if (signal.aborted) return Promise.reject(new DOMException('Score estimation cancelled', 'AbortError'));
  return new Promise<EstimateResponse>((resolve, reject) => {
    let worker: EstimatorWorker;
    try { worker = createWorker(); }
    catch { reject(Error(UNSUPPORTED_ESTIMATOR)); return; }
    let settled = false;
    const finish = (result?: EstimateResponse, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException('Score estimation cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(undefined, Error('Score estimation timed out')), 20000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data && 'result' in data) finish(data.result);
      else finish(undefined, Error(data && 'error' in data ? data.error : ESTIMATOR_LOAD_ERROR));
    };
    worker.onerror = event => { event.preventDefault(); finish(undefined, Error(ESTIMATOR_LOAD_ERROR)); };
    worker.onmessageerror = () => finish(undefined, Error(ESTIMATOR_LOAD_ERROR));
    const send = (module?: WebAssembly.Module) => {
      if (settled) return;
      try { worker.postMessage(module ? { status, module } : status); }
      catch { finish(undefined, Error(ESTIMATOR_LOAD_ERROR)); }
    };
    if (module) void Promise.resolve(module).then(send,
      () => finish(undefined, Error(ESTIMATOR_LOAD_ERROR)));
    else send();
  });
}


export async function preloadLocalEstimate() {
  if (!supportsLocalEstimate()) return;
  const { loadEstimatorModule } = await import('./fox-score-worker-client.ts');
  await loadEstimatorModule();
}

export const localEstimate: Estimator = ({ payload, signal }) => {
  if (!supportsLocalEstimate()) return Promise.reject(Error(UNSUPPORTED_ESTIMATOR));
  return import('./fox-score-worker-client.ts')
    .then(({ createEstimatorWorker, loadEstimatorModule }) =>
      estimateInWorker(payload.status, signal, createEstimatorWorker, loadEstimatorModule()),
      () => { throw Error(ESTIMATOR_LOAD_ERROR); });
};
