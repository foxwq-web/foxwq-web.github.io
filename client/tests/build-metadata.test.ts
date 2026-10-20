import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBuildSha } from '../scripts/build-metadata.ts';

test('source archives build without Git metadata and accept an explicit revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foxwq-web-source-'));
  try {
    assert.equal(resolveBuildSha({ env: {}, cwd: directory }), 'unknown');
    assert.equal(resolveBuildSha({ env: { CLIENT_BUILD_SHA: ' release-123 ' }, cwd: directory }), 'release-123');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('working checkouts embed their current revision by default', () => {
  assert.equal(resolveBuildSha({ env: {} }), execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
});
