import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

async function compileWorker(path: string) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', target: 'es2022', external: ['cloudflare:sockets'] });
  return result.outputFiles[0].text;
}


test('Worker authenticates upgrades and relays opaque binary chunks in both directions', { timeout: 30000 }, async () => {
  const sockets = new Set<Socket>();
  const tcp = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => socket.write(data));
  });
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const address = tcp.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  const modules = await Promise.all(['index.ts'].map(async name => {
    const path = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
    return { type: 'ESModule' as const, path, contents: await compileWorker(path) };
  }));
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules, compatibilityDate: '2026-10-08',
    outboundService: () => assert.fail('Unexpected outbound HTTP request'),
    bindings: { PROXY_TOKEN: 'a'.repeat(43), ALLOWED_ORIGINS: 'http://localhost:5173', ALLOWED_TARGETS: `127.0.0.1:${port}` }
  }));
  let ws: Awaited<ReturnType<typeof mf.dispatchFetch>>['webSocket'] = null;
  const headers = { Upgrade: 'websocket', Origin: 'http://localhost:5173', 'Sec-WebSocket-Protocol': `tcp-proxy, ${'a'.repeat(43)}` };
  try {
    const endpoint = `http://localhost/proxy?host=127.0.0.1&port=${port}`;
    assert.equal((await mf.dispatchFetch('http://localhost/health')).status, 200);
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      assert.equal((await mf.dispatchFetch('http://localhost/estimate', { method })).status, 404);
    }

    assert.equal((await mf.dispatchFetch(endpoint)).status, 426);
    assert.equal((await mf.dispatchFetch(endpoint, { headers: { ...headers, 'Sec-WebSocket-Protocol': 'tcp-proxy, invalid' } })).status, 401);
    assert.equal((await mf.dispatchFetch(endpoint, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await mf.dispatchFetch('http://localhost/proxy?host=127.0.0.1&port=1', { headers })).status, 403);
    const response = await mf.dispatchFetch(endpoint, { headers });
    assert.equal(response.status, 101); assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'tcp-proxy');
    const websocket = response.webSocket;
    assert.ok(websocket);
    ws = websocket; websocket.accept();
    const chunks: Buffer[] = [], received = new Promise<Buffer>((resolve, reject) => {
      websocket.addEventListener('message', event => { assert.ok(event.data instanceof ArrayBuffer); chunks.push(Buffer.from(event.data)); if (Buffer.concat(chunks).length === 7) resolve(Buffer.concat(chunks)); });
      websocket.addEventListener('error', reject);
    });
    ws.send(Uint8Array.from([0,255,8]).buffer); ws.send(Uint8Array.from([13,10,99,128]).buffer);
    assert.deepEqual(await received, Buffer.from([0,255,8,13,10,99,128]));
    const closed = new Promise<{ code: number }>(resolve => websocket.addEventListener('close', resolve, { once: true }));
    ws.send('not binary'); assert.equal((await closed).code, 1003);
  } finally {
    ws?.close(); await mf.dispose(); for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => tcp.close(error => error ? reject(error) : resolve()));
  }
});

test('history relay forwards client authentication unchanged to a fixed Fox destination', async () => {
  const path = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  let requests = 0;
  const query = '?type=1&lastCode=&FindUserName=&uid=42&srcuid=7&time=1792700000&session=client-signature&token=%2B%2F8AAQ%3D%3D&host=evil.example';
  let upstreamStatus = 200;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: 'ESModule' as const, path, contents: await compileWorker(path) }], compatibilityDate: '2026-10-08',
    outboundService: async request => {
      requests++;
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://newframe.foxwq.com');
      assert.equal(url.pathname, '/chessbook/TXWQFetchChessList');
      assert.equal(url.search, query);
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('Authorization'), null);
      assert.equal(request.headers.get('Origin'), null);
      return new Response('fox-response', { status: upstreamStatus, headers: { 'Content-Type': 'text/plain' } });
    },
    bindings: { PROXY_TOKEN: 'a'.repeat(43), ALLOWED_ORIGINS: 'http://localhost:5173', ALLOWED_TARGETS: '' }
  }));
  const headers = { Origin: 'http://localhost:5173', Authorization: `Bearer ${'a'.repeat(43)}` };
  const endpoint = 'http://localhost/fox/chessbook/TXWQFetchChessList';
  const get = (extra = {}) => mf.dispatchFetch(endpoint + query, { headers: { ...headers, ...extra } });
  try {
    const preflight = await mf.dispatchFetch(endpoint, { method: 'OPTIONS', headers });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET');
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), headers.Origin);
    assert.equal((await get({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await get({ Authorization: 'wrong' })).status, 401);
    assert.equal((await mf.dispatchFetch(endpoint, { method: 'POST', headers })).status, 405);
    assert.equal((await mf.dispatchFetch('http://localhost/fox/cgi/UpdateToken', { headers })).status, 404);
    assert.equal((await mf.dispatchFetch('http://localhost/player-history', { headers })).status, 404);
    assert.equal(requests, 0);
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), headers.Origin);
    assert.equal(response.headers.get('Content-Type'), 'text/plain');
    assert.equal(await response.text(), 'fox-response');
    upstreamStatus = 403;
    const rejected = await get();
    assert.equal(rejected.status, 403);
    assert.equal(await rejected.text(), 'fox-response');
    assert.equal(requests, 2);
  } finally { await mf.dispose(); }
});
