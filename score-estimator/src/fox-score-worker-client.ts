import wasmUrl from '../artifacts/fox-score.wasm?url';
import { compileScoreWasm } from './fox-score-wasm.ts';
import type { EstimatorWorker } from './local-score-estimation.ts';


export function createEstimatorWorker(): EstimatorWorker {
  return new Worker(new URL('./fox-score-worker.ts', import.meta.url), { type: 'module' });
}

let compiled: Promise<WebAssembly.Module> | null = null;
export function loadEstimatorModule() {
  return compiled ??= compileScoreWasm(wasmUrl).catch(error => {
    compiled = null;
    throw error;
  });
}
