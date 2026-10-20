import test from 'node:test';
import assert from 'node:assert/strict';
import { compileScoreWasm } from '../src/fox-score-wasm.ts';
import { estimateInWorker, localEstimate, supportsLocalEstimate,
  ESTIMATOR_LOAD_ERROR, UNSUPPORTED_ESTIMATOR, type EstimatorWorker, type EstimatorRequest } from '../src/local-score-estimation.ts';

const status = '0'.repeat(361);
class FakeWorker implements EstimatorWorker {
  onmessage: EstimatorWorker['onmessage'] = null;
  onerror: EstimatorWorker['onerror'] = null;
  onmessageerror: EstimatorWorker['onmessageerror'] = null;
  sent: EstimatorRequest[] = [];
  terminated = 0;
  postMessage(data: EstimatorRequest) { this.sent.push(data); }
  terminate() { this.terminated++; }
}

test('local estimator sends only the board and terminates its worker after success', async () => {
  const worker = new FakeWorker();
  const pending = estimateInWorker(status, new AbortController().signal, () => worker);
  assert.deepEqual(worker.sent, [status]);
  const result = { ret: 0, board_size: 19, judge_status: status };
  worker.onmessage!({ data: { result } } as MessageEvent);
  assert.deepEqual(await pending, result);
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
});

test('cancelling terminates computation and rejects without accepting late results', async () => {
  const controller = new AbortController(), worker = new FakeWorker();
  const pending = estimateInWorker(status, controller.signal, () => worker);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  await assert.rejects(estimateInWorker(status, controller.signal, () => { throw Error('should not start'); }), { name: 'AbortError' });
});

test('the worker deadline terminates stalled startup or calculation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new FakeWorker();
  const pending = estimateInWorker(status, new AbortController().signal, () => worker);
  const rejected = assert.rejects(pending, /timed out/);
  context.mock.timers.tick(20000);
  await rejected;
  assert.equal(worker.terminated, 1);
});

test('unsupported worker, loading/CSP errors, and message failures are recoverable', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(estimateInWorker(status, signal, () => { throw Error('CSP blocked'); }), { message: UNSUPPORTED_ESTIMATOR });
  for (const kind of ['error', 'messageerror', 'engine'] as const) {
    const worker = new FakeWorker();
    const pending = estimateInWorker(status, signal, () => worker);
    if (kind === 'error') worker.onerror!({ preventDefault() {} } as ErrorEvent);
    else if (kind === 'messageerror') worker.onmessageerror!({} as MessageEvent);
    else worker.onmessage!({ data: { error: ESTIMATOR_LOAD_ERROR } } as MessageEvent);
    await assert.rejects(pending, { message: ESTIMATOR_LOAD_ERROR });
    assert.equal(worker.terminated, 1);
  }
});

test('missing browser capabilities produce a useful unavailable state', async () => {
  assert.equal(supportsLocalEstimate(), false, 'Node has no browser Worker');
  await assert.rejects(localEstimate({ payload: { status } } as Parameters<typeof localEstimate>[0]), { message: UNSUPPORTED_ESTIMATOR });
});

test('standalone WASM loads as buffered bytes and propagates asset/compile failures', async () => {
  const loaded: string[] = [];
  const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const result = await compileScoreWasm('engine', async url => {
    loaded.push(url); return Uint8Array.of(1);
  }, async bytes => { assert.equal(bytes[0], 1); return module; });
  assert.equal(result, module);
  assert.deepEqual(loaded, ['engine']);
  await assert.rejects(compileScoreWasm('engine', async () => { throw Error('offline'); }), /offline/);
  await assert.rejects(compileScoreWasm('engine', async () => Uint8Array.of(1)), WebAssembly.CompileError);
});

test('a precompiled module is sent to the scoring worker with the board', async () => {
  const worker = new FakeWorker();
  const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const pending = estimateInWorker(status, new AbortController().signal, () => worker, module);
  await Promise.resolve();
  assert.deepEqual(worker.sent, [{ status, module }]);
  const result = { ret: 0, board_size: 19, judge_status: status };
  worker.onmessage!({ data: { result } } as MessageEvent);
  assert.deepEqual(await pending, result);
  assert.equal(worker.terminated, 1);
});

test('cancellation and the deadline also cover a pending module download', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cancel of [true, false]) {
    const worker = new FakeWorker(), controller = new AbortController();
    let loaded!: (module: WebAssembly.Module) => void;
    const module = new Promise<WebAssembly.Module>(resolve => { loaded = resolve; });
    const pending = estimateInWorker(status, controller.signal, () => worker, module);
    const rejected = assert.rejects(pending, cancel ? { name: 'AbortError' } : /timed out/);
    if (cancel) controller.abort(); else context.mock.timers.tick(20000);
    await rejected;
    loaded(new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)));
    await Promise.resolve();
    assert.deepEqual(worker.sent, []);
    assert.equal(worker.terminated, 1);
  }
});
