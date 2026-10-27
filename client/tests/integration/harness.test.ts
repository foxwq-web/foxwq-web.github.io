import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium, type Browser } from 'playwright';
import { encode as frame, gatewayPayload } from '../../src/framing.ts';
import { unpack } from '../../src/game.ts';
import { encode } from '../../src/wire.ts';
import { replay } from './replay.ts';
import { packets, identify } from './log.ts';
import { checkGolden, artifacts } from './artifacts.ts';
import type { NetworkEntry } from '../../src/network-log.ts';

const fixture: NetworkEntry[] = JSON.parse(await readFile(new URL('./fixtures/fox-network-log-20261021T2028.network.json', import.meta.url), 'utf8'));
let work: string, server: Awaited<ReturnType<typeof preview>>, browser: Browser, url: string;
before(async () => {
  work = await mkdtemp(join(tmpdir(), 'fox-replay-harness-'));
  const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url)), outDir = join(work, 'dist');
  await build({ configFile, logLevel: 'silent', build: { outDir }, define: { __CLIENT_BUILD__: JSON.stringify({ gitSha: 'network-replay' }) } });
  server = await preview({ configFile, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  if (work) await rm(work, { recursive: true, force: true });
});

test('production UI replay is deterministic across fresh contexts', async () => {
  const expected = JSON.parse(await readFile(new URL('./fixtures/fox-network-log-20261021T2028.golden.json', import.meta.url), 'utf8'));
  for (let i = 0; i < 2; i++) {
    const result = await replay(browser, url, fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(result.snapshot)), expected);
    assert.deepEqual(result.entries, fixture);
  }
});

test('queued sends survive intervening discovery responses on another connection', async () => {
  const delayed = structuredClone(fixture);
  const login = packets(delayed).findIndex(packet => packet.outbound && identify(packet.frame) === '20001/1');
  const [send] = delayed.splice(login, 1);
  const response = packets(delayed).findIndex(packet => !packet.outbound && identify(packet.frame) === '20001/1');
  send.timestamp = delayed[response].timestamp;
  delayed.splice(response, 0, send);
  const result = await replay(browser, url, delayed);
  assert.deepEqual(result.entries, delayed);
  assert.deepEqual(JSON.parse(JSON.stringify(result.snapshot)), JSON.parse(await readFile(new URL('./fixtures/fox-network-log-20261021T2028.golden.json', import.meta.url), 'utf8')));
});

test('a changed client packet fails even when the final UI would be unchanged; update repairs it', async () => {
  const changed = structuredClone(fixture);
  const index = packets(changed).findIndex(packet => packet.outbound && identify(packet.frame) === '31000/201');
  // Color is part of the expected wire bytes, but UI inference uses coordinates.
  const [header, body] = unpack(packets(changed)[index].frame.payload);
  const fields = (message: typeof body) => Object.fromEntries([...message].map(([key, values]) => [key, values]));
  changed[index].payload = frame(26200, gatewayPayload(encode(fields(header)), encode({ ...fields(body), 3: body.number(3) === 1 ? 2 : 1 })), true).toString('base64');
  await assert.rejects(replay(browser, url, changed), /outbound 31000\/201 differs at byte/);
  const updated = await replay(browser, url, changed, true);
  assert.deepEqual(updated.entries, fixture);
  await replay(browser, url, updated.entries);
});

test('message updates handle added and removed automatic requests without changing server bytes', async () => {
  const changed = structuredClone(fixture);
  const index = packets(changed).findIndex(packet => packet.outbound && identify(packet.frame) === '20043/1001');
  changed.splice(index, 1); // Current code now emits an additional prefetch here.
  changed.splice(4, 0, { ...changed[3], payload: frame(3999, new Uint8Array()).toString('base64') }); // An obsolete automatic request.
  await assert.rejects(replay(browser, url, changed), /no outbound 3999/);
  const updated = await replay(browser, url, changed, true);
  const serverBytes = (entries: NetworkEntry[]) => entries.filter(entry => !entry.source.startsWith('client:')).map(entry => entry.payload);
  assert.deepEqual(serverBytes(updated.entries), serverBytes(fixture));
  assert.deepEqual(updated.entries.map(entry => entry.payload), fixture.map(entry => entry.payload));
  await replay(browser, url, updated.entries);
});

test('goldens record once, fail without overwriting, update explicitly, and are required in CI', async () => {
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
