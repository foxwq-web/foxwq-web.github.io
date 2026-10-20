import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const estimator = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw Error('Usage: npm run score-estimator:build -- [--check]');
const { platform } = JSON.parse(await readFile(join(estimator, 'scripts/toolchain.json'), 'utf8'));
const output = await mkdtemp(join(tmpdir(), 'foxwq-web-wasm-'));
const files = [
  ['fox-score.wasm', 'artifacts/fox-score.wasm'],
  ['fox-score-bindings.json', 'artifacts/fox-score-bindings.json'],
  ['report.json', 'scripts/report.json']
];
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['buildx', 'build', '--platform', platform,
      '--file', join(estimator, 'Dockerfile'), '--output', `type=local,dest=${output}`, estimator], { stdio: 'inherit' });
    child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT'
      ? Error('Docker with Buildx is required. Install/start Docker, or use npm run score-estimator:build:native.') : error));
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`Docker build failed (${code})`)));
  });

  const binary = await readFile(join(output, 'fox-score.wasm'));
  const bindings = JSON.parse(await readFile(join(output, 'fox-score-bindings.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  const hash = createHash('sha256').update(binary).digest('hex');
  if (hash !== bindings.wasm_sha256 || hash !== report.wasm_sha256) throw Error('Rebuilt artifact hashes disagree');
  if (check) {

    for (const [source, target] of files.slice(0, 2)) {
      if (!(await readFile(join(output, source))).equals(await readFile(join(estimator, target))))
        throw Error(`${target} differs from the canonical rebuild. Run npm run score-estimator:build and commit the result.`);
    }
    const existing = JSON.parse(await readFile(join(estimator, 'scripts/report.json'), 'utf8'));
    if (JSON.stringify(report.sources_sha256) !== JSON.stringify(existing.sources_sha256))
      throw Error('The checked-in audit report does not match the translator sources');
    console.log('Canonical WASM rebuild matches checked-in artifacts and source hashes.');
  } else {
    for (const [source, target] of files) await copyFile(join(output, source), join(estimator, target));
    console.log('Installed rebuilt WASM, bindings, and audit report.');
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
