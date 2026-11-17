import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifacts, checkGolden } from './integration/artifacts.ts';

test('goldens record once, fail without overwriting, update explicitly, and are required in CI', async t => {
  const work = await mkdtemp(join(tmpdir(), 'fox-golden-check-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const path = join(work, 'golden-check.network.json'), { golden, actual } = artifacts(path);
  await assert.rejects(checkGolden(path, { state: 1 }, { ci: true }), /Missing golden/);
  assert.equal(await checkGolden(path, { state: 1, absent: undefined }), 'RECORDED');
  assert.equal(await checkGolden(path, { state: 1 }), 'PASS');
  const original = await readFile(golden, 'utf8');
  await assert.rejects(checkGolden(path, { state: 2 }), /UI differs/);
  assert.equal(await readFile(golden, 'utf8'), original);
  assert.deepEqual(JSON.parse(await readFile(actual, 'utf8')), { state: 2 });
  assert.equal(await checkGolden(path, { state: 2 }, { update: true }), 'UPDATED');
  assert.equal(await checkGolden(path, { state: 2 }, { ci: true }), 'PASS');
  await assert.rejects(readFile(actual), { code: 'ENOENT' });
});
