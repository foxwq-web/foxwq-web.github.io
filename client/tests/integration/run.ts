import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { normalizeLog } from './log.ts';
import { replay } from './replay.ts';
import { artifacts, checkGolden, exists, json } from './artifacts.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
async function main() {
  const args = process.argv.slice(2), files: string[] = [];
  let update = false, updateMessages = false, ci = !!process.env.CI, importFile = '', name = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--update') update = true;
    else if (arg === '--update-messages') updateMessages = true;
    else if (arg === '--ci') ci = true;
    else if (arg === '--import' || arg === '--name') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`${arg} needs a value.`);
      if (arg === '--import') importFile = value; else name = value;
    } else if (arg === '--help') {
      console.log(`Offline production-browser network replay

npm run test:integration                            Check all checked-in fixtures
npm run test:integration -- --import LOG --name NAME Import, truncate and record a new fixture
npm run test:integration -- path/to/log.json         Check a log; create its golden on first run
npm run test:integration:update                     Update UI goldens
npm run test:integration:update -- --update-messages Update goldens and client packets
npm run test:integration -- --ci                    Require existing goldens; never write fixtures

Authentication is normalized to synthetic credentials. All other client frames
are compared byte for byte. See client/tests/integration/README.md.`);
      return;
    } else if (arg.startsWith('-')) throw Error(`Unknown option ${arg}`);
    else files.push(resolve(arg));
  }
  if (updateMessages && !update) throw Error('--update-messages requires --update (or test:integration:update).');
  if (ci && (update || importFile)) throw Error('CI mode cannot import fixtures or update artifacts.');
  if (name && !importFile) throw Error('--name requires --import.');
  if (importFile) {
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw Error('--import requires --name with letters, numbers, dashes or underscores.');
    const destination = join(fixtures, `${name}.network.json`);
    if (await exists(destination)) throw Error(`Fixture already exists: ${destination}`);
    const normalized = normalizeLog(JSON.parse(await readFile(resolve(importFile), 'utf8')));
    await mkdir(fixtures, { recursive: true });
    await writeFile(destination, json(normalized.entries), { flag: 'wx' });
    console.log(`Imported ${name}: discarded ${normalized.discarded} entries before the last login; authentication normalized${normalized.synthetic ? ' and reconstructed' : ''}.`);
    files.push(destination);
  }
  if (!files.length) files.push(...(await readdir(fixtures)).filter(file => file.endsWith('.network.json')).sort().map(file => join(fixtures, file)));
  assert.ok(files.length, 'No integration fixtures. Import a network log with --import LOG --name NAME.');
  const work = await mkdtemp(join(tmpdir(), 'fox-network-replay-'));
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let failures = 0;
  try {
    const outDir = join(work, 'dist');
    await build({ configFile, logLevel: 'warn', define: { __CLIENT_BUILD__: JSON.stringify({ gitSha: 'network-replay' }) }, build: { outDir, emptyOutDir: true } });
    server = await preview({ configFile, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    for (const file of files) {
      const { golden } = artifacts(file);
      try {
        if (ci && !await exists(golden)) throw Error(`Missing golden: ${golden}. Record it locally and commit it.`);
        const result = await replay(browser, `http://127.0.0.1:${address.port}`, JSON.parse(await readFile(file, 'utf8')), updateMessages);
        if (updateMessages) {
          try {
            const verified = await replay(browser, `http://127.0.0.1:${address.port}`, result.entries);
            assert.deepEqual(JSON.parse(json(verified.snapshot)), JSON.parse(json(result.snapshot)), 'Updated transcript changed the final UI');
          } catch (error) {
            throw Error(`Updated client traffic cannot replay against the recorded server responses. No artifacts were updated. ${error instanceof Error ? error.message : error}`);
          }
        }
        // Do not change either artifact until the whole replay has succeeded.
        const status = await checkGolden(file, result.snapshot, { update, ci });
        if (updateMessages) await writeFile(file, json(result.entries));
        console.log(`${status} ${basename(file)} (${result.entries.length} packets${result.discarded ? `; ${result.discarded} older entries ignored` : ''})`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${basename(file)}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>((resolve, reject) => server!.httpServer.close(error => error ? reject(error) : resolve()));
    await rm(work, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
