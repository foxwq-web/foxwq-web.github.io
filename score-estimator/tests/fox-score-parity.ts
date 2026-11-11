import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runFoxEstimate, type FoxEngineDiagnostics } from '../src/fox-score-runtime.ts';

// The engine search is synchronous, so tests in one file cannot overlap.
// Each part registers its share in a separate file, which node --test runs
// in its own process.
export async function registerParityTests(part: number, parts: number) {
  const [binary, fixture, additional] = await Promise.all([
    readFile(new URL('../artifacts/fox-score.wasm', import.meta.url)),
    readFile(new URL('./fixtures/fox-native-estimates.json', import.meta.url)),
    readFile(new URL('./fixtures/fox-native-translated-estimates.json', import.meta.url)),
  ]);
  const wasm = await WebAssembly.compile(binary);
  const positions = [...JSON.parse(fixture.toString()).positions,
    ...JSON.parse(additional.toString()).positions];
  positions.forEach((expected, index) => {
    if (index % parts !== part) return;
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
  });
}
