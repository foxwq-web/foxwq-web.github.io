import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const estimator = fileURLToPath(new URL('../', import.meta.url));

test('container export checks detect drift without installing; rebuild installs a consistent artifact set', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'foxwq-web-build-check-'));
  try {
    const checkout = join(temporary, 'checkout');
    const fixture = join(temporary, 'export');
    const bin = join(temporary, 'bin');
    for (const directory of [join(checkout, 'scripts'), join(checkout, 'artifacts'), fixture, bin])
      await mkdir(directory, { recursive: true });
    for (const file of ['scripts/build-docker.ts', 'scripts/toolchain.json', 'scripts/report.json',
      'artifacts/fox-score.wasm', 'artifacts/fox-score-bindings.json'])
      await copyFile(join(estimator, file), join(checkout, file));
    await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
    for (const [source, target] of [['artifacts/fox-score.wasm', 'fox-score.wasm'],
      ['artifacts/fox-score-bindings.json', 'fox-score-bindings.json'], ['scripts/report.json', 'report.json']])
      await copyFile(join(estimator, source), join(fixture, target));

    await writeFile(join(bin, 'docker'), `#!${process.execPath}
const { copyFileSync } = require('node:fs');
const { join } = require('node:path');
const output = process.argv[process.argv.indexOf('--output') + 1].slice('type=local,dest='.length);
for (const file of ['fox-score.wasm', 'fox-score-bindings.json', 'report.json'])
  copyFileSync(join(process.env.TEST_DOCKER_EXPORT, file), join(output, file));
`, { mode: 0o755 });
    const run = (...args: string[]) => execute(process.execPath, [join(checkout, 'scripts/build-docker.ts'), ...args], {
      cwd: temporary, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_EXPORT: fixture }
    });
    assert.match((await run('--check')).stdout, /matches checked-in artifacts/);
    const original = await readFile(join(checkout, 'artifacts/fox-score.wasm'));
    const changed = Buffer.concat([original, Buffer.from([0])]);
    const digest = createHash('sha256').update(changed).digest('hex');
    await writeFile(join(fixture, 'fox-score.wasm'), changed);
    for (const name of ['fox-score-bindings.json', 'report.json']) {
      const metadata = JSON.parse(await readFile(join(fixture, name), 'utf8'));
      metadata.wasm_sha256 = digest;
      await writeFile(join(fixture, name), JSON.stringify(metadata));
    }
    await assert.rejects(run('--check'), error => typeof error === 'object' && error !== null && 'stderr' in error && /differs from the canonical rebuild/.test(String(error.stderr)));
    assert.deepEqual(await readFile(join(checkout, 'artifacts/fox-score.wasm')), original);
    await run();
    assert.deepEqual(await readFile(join(checkout, 'artifacts/fox-score.wasm')), changed);
    assert.equal(JSON.parse(await readFile(join(checkout, 'scripts/report.json'), 'utf8')).wasm_sha256, digest);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
