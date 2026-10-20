import wasmUrl from '../artifacts/fox-score.wasm?url';
import { runFoxEstimate } from './fox-score-runtime.ts';
import { compileScoreWasm } from './fox-score-wasm.ts';
import type { EstimatorRequest } from './local-score-estimation.ts';
import { ESTIMATOR_LOAD_ERROR } from './fox-score-errors.ts';

const scope = self as unknown as {
  postMessage(data: unknown): void;
  onmessage: (event: MessageEvent<EstimatorRequest>) => void;
};
scope.onmessage = async ({ data }: MessageEvent<EstimatorRequest>) => {
  const status = typeof data === 'string' ? data : data?.status;
  if (typeof status !== 'string' || !/^[012]{361}$/.test(status)) {
    scope.postMessage({ error: 'Invalid board' });
    return;
  }
  try {
    scope.postMessage({ result: await runFoxEstimate(status, typeof data === 'string' ? await compileScoreWasm(wasmUrl) : data.module) });
  } catch { scope.postMessage({ error: ESTIMATOR_LOAD_ERROR }); }
};
