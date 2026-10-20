import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runFoxEstimate, type FoxEngineDiagnostics } from '../src/fox-score-runtime.ts';
import bindings from '../artifacts/fox-score-bindings.json';
import { Board } from '../../client/src/board.ts';
import { decodeEstimate } from '../src/score-estimation.ts';

const bytes = (path: string) => readFile(new URL(path, import.meta.url));
const [inputBytes, binary, fixture, additional, compactFixture, reportBytes] = await Promise.all([
  bytes('../scripts/inputs.json'),
  bytes('../artifacts/fox-score.wasm'), bytes('./fixtures/fox-native-estimates.json'),
  bytes('./fixtures/fox-native-translated-estimates.json'), bytes('./fixtures/fox-native-go-compact-groups.json'),
  bytes('../scripts/report.json'),
]);
const references = JSON.parse(fixture.toString());
const report = JSON.parse(reportBytes.toString());
const wasm = await WebAssembly.compile(binary);
const digest = (image: Uint8Array) => createHash('sha256').update(image).digest('hex');

test('standalone translation is pinned to its source DLLs, generator, and WASM artifact', async () => {
  const inputs = JSON.parse(inputBytes.toString());
  assert.deepEqual(inputs.dll_sha256, references.dll_sha256);
  assert.deepEqual(report.dll_sha256, inputs.dll_sha256);
  for (const name of ['SE.dll', 'GoStar5M.dll'] as const) {
    assert.equal(bindings.dll_sha256[name], references.dll_sha256[name]);
  }
  assert.equal(digest(binary), bindings.wasm_sha256);
  assert.equal(report.wasm_sha256, bindings.wasm_sha256);
  assert.equal(binary.length, report.wasm_bytes);
  assert.ok(binary.length <= 10_000_000, 'standalone engine stays under 10 MB');
  assert.ok(report.max_function_bytes <= 1024 * 1024, 'optimizer preserves bounded browser-compatible functions');
  assert.equal(report.instructions, 217328, 'size reduction retains all discovered instructions');
  for (const [name, hash] of Object.entries(report.sources_sha256))
    assert.equal(digest(await bytes(`../scripts/${name}`)), hash, name);
  assert.deepEqual(WebAssembly.Module.imports(wasm).map(({ module, name, kind }) =>
    `${module}.${name}:${kind}`).sort(), ['env.service:function', 'env.trace:function']);
});

for (const expected of [...references.positions, ...JSON.parse(additional.toString()).positions]) {
  test(`statically translated search, territory, and penalties match native: ${expected.name}`, async () => {
    let diagnostic: FoxEngineDiagnostics | undefined;
    const result = await runFoxEstimate(expected.status, wasm, value => { diagnostic = value; });
    assert.deepEqual(diagnostic!.initialGroups, expected.go_groups, 'native board construction before search');
    assert.equal(diagnostic!.preliminaryOwnership, expected.go_ownership, 'GoStar territory before correction');
    assert.deepEqual(diagnostic!.groups, expected.go_final, 'life/death flags and restored board after search');
    assert.equal(diagnostic!.nativeOwnership, expected.ownership, 'full SE output including seki');
    assert.equal(result.judge_status, expected.ownership.replaceAll('3', '0'), 'gameplay treats seki as neutral');
    assert.equal(result.black_penalty, expected.black_penalty);
    assert.equal(result.white_penalty, expected.white_penalty);
  });
}

for (const expected of JSON.parse(compactFixture.toString()).positions) {
  test(`static native compact/large-group construction: ${expected.name}`, async () => {
    let diagnostic: FoxEngineDiagnostics | undefined;
    await runFoxEstimate(expected.status, wasm, value => { diagnostic = value; });
    assert.deepEqual(diagnostic!.initialGroups, expected.go_groups);
  });
}

test('displayed scores match the original Fox panel in all five reported screenshots', async () => {
  // Positions and expected panel totals transcribed from the user's screenshots
  // of 2026-10-20, at 08.01.43, 08.01.58, 08.02.12, 08.02.27 and 08.04.58.
  const moves = [[15, 3], [3, 3], [16, 5], [3, 15], [15, 15],
    [13, 16], [11, 16], [13, 14], [15, 13], [10, 15], [11, 15]];
  const expected = new Map([
    [5, [42, 30, 4.5]],
    [6, [33, 33, -7.5]],
    [7, [33, 30, -4.5]],
    [8, [32, 30, -5.5]],
    [11, [40, 30, 2.5]],
  ]);
  const board = new Board();
  for (const [i, [x, y]] of moves.entries()) {
    board.play(x, y);
    const totals = expected.get(i + 1);
    if (!totals) continue;
    const response = await runFoxEstimate(board.stones.join(''), wasm);
    const result = decodeEstimate(response, board, 7.5);
    assert.deepEqual([result.black, result.white, result.lead], totals, `move ${i + 1}`);
  }
});

test('translation rejects invalid boards, unknown targets, and exhausted fuel with fixed memory', async () => {
  await assert.rejects(runFoxEstimate('0'.repeat(360), wasm), /Invalid board/);
  await assert.rejects(runFoxEstimate('3'.repeat(361), wasm), /Invalid board/);
  const instance = await WebAssembly.instantiate(wasm, { env: { service() {}, trace() {} } });
  const engine = instance.exports as unknown as {
    initialize(): void; execute(address: number, fuel: number): number; memory: WebAssembly.Memory;
  };
  engine.initialize();
  assert.equal(engine.execute(0xdead, 10), 4, 'unknown code cannot fall back to an interpreter');
  assert.equal(engine.execute(bindings.exports['SE.dll'].ScoreEstimate, 0), 3, 'instruction limit');
  assert.throws(() => engine.memory.grow(1), RangeError, 'no unbounded memory growth');
});
