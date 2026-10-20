import wasmUrl from '../artifacts/fox-score.wasm?url';
import { runFoxEstimate } from './fox-score-runtime.ts';
import { compileScoreWasm } from './fox-score-wasm.ts';
import { ESTIMATOR_LOAD_ERROR } from './fox-score-errors.ts';

const scope = self as unknown as {
  postMessage(data: unknown): void;
  onmessage: (event: MessageEvent<string>) => void;
};
scope.onmessage = async ({ data }: MessageEvent<string>) => {
  if (typeof data !== 'string' || !/^[012]{361}$/.test(data)) {
    scope.postMessage({ error: 'Invalid board' });
    return;
  }
  try {
    scope.postMessage({ result: await runFoxEstimate(data, await compileScoreWasm(wasmUrl)) });
  } catch { scope.postMessage({ error: ESTIMATOR_LOAD_ERROR }); }
};
