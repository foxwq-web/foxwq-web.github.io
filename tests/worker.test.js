import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Run the actual Worker in workerd against a generic TCP echo service.
test('Worker authenticates upgrades and relays opaque binary chunks in both directions', { timeout: 30000 }, async () => {
  const sockets = new Set();
  const tcp = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => socket.write(data));
  });
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const port = tcp.address().port;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'proxy/index.js', compatibilityDate: '2026-10-08',
    bindings: { PROXY_TOKEN: 'a'.repeat(43), ALLOWED_ORIGINS: 'http://localhost:5173', ALLOWED_TARGETS: `127.0.0.1:${port}` }
  }));
  let ws;
  const headers = { Upgrade: 'websocket', Origin: 'http://localhost:5173', 'Sec-WebSocket-Protocol': `tcp-proxy, ${'a'.repeat(43)}` };
  try {
    const endpoint = `http://localhost/proxy?host=127.0.0.1&port=${port}`;
    assert.equal((await mf.dispatchFetch('http://localhost/health')).status, 200);
    assert.equal((await mf.dispatchFetch(endpoint)).status, 426);
    assert.equal((await mf.dispatchFetch(endpoint, { headers: { ...headers, 'Sec-WebSocket-Protocol': 'tcp-proxy, invalid' } })).status, 401);
    assert.equal((await mf.dispatchFetch(endpoint, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await mf.dispatchFetch('http://localhost/proxy?host=127.0.0.1&port=1', { headers })).status, 403);
    const response = await mf.dispatchFetch(endpoint, { headers });
    assert.equal(response.status, 101); assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'tcp-proxy');
    ws = response.webSocket; ws.accept(); ws.binaryType = 'arraybuffer';
    const chunks = [], received = new Promise((resolve, reject) => {
      ws.addEventListener('message', event => { chunks.push(Buffer.from(event.data)); if (Buffer.concat(chunks).length === 7) resolve(Buffer.concat(chunks)); });
      ws.addEventListener('error', reject);
    });
    ws.send(Uint8Array.from([0,255,8]).buffer); ws.send(Uint8Array.from([13,10,99,128]).buffer);
    assert.deepEqual(await received, Buffer.from([0,255,8,13,10,99,128]));
    const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
    ws.send('not binary'); assert.equal((await closed).code, 1003);
  } finally {
    ws?.close(); await mf.dispose(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => tcp.close(resolve));
  }
});
