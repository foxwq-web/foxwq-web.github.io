import type { EstimatorWorker } from './local-score-estimation.ts';


export function createEstimatorWorker(): EstimatorWorker {
  return new Worker(new URL('./fox-score-worker.ts', import.meta.url), { type: 'module' });
}
