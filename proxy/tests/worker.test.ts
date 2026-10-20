import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { transform } from 'esbuild';


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
    const source = await readFile(path, 'utf8');
    const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
    return { type: 'ESModule' as const, path, contents: compiled.code };
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
      assert.equal((await mf.dispatchFetch('http://localhost/unknown', { method })).status, 404);
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
