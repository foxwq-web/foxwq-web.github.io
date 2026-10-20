import { connect } from 'cloudflare:sockets';

interface Env extends Omit<ProxyBindings, 'PROXY_TOKEN'> {
  PROXY_TOKEN?: string;
}


const LIMIT = 1024 * 1024;
const list = (value?: string | null) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
function equalSecret(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (url.pathname !== '/proxy') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const protocols = list(request.headers.get('Sec-WebSocket-Protocol'));
    if (protocols[0] !== 'tcp-proxy' || !equalSecret(protocols[1], env.PROXY_TOKEN)) return new Response('Unauthorized', { status: 401 });
    const origins = list(env.ALLOWED_ORIGINS);
    const origin = request.headers.get('Origin');
    if (!origin || !origins.includes(origin)) return new Response('Origin forbidden', { status: 403 });
    const hostname = url.searchParams.get('host') ?? '', rawPort = url.searchParams.get('port') ?? '';
    const port = Number(rawPort);
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || !/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535) return new Response('Invalid target', { status: 400 });
    if (!list(env.ALLOWED_TARGETS).includes(`${hostname}:${port}`)) return new Response('Target forbidden', { status: 403 });
    let socket: Socket | undefined;
    try {
      socket = connect({ hostname, port }, { secureTransport: 'off', allowHalfOpen: false });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([socket.opened, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 10000); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    } catch { socket?.close().catch(() => {}); return new Response('TCP connection failed', { status: 502 }); }
    const tcpSocket = socket;
    const [client, server] = Object.values(new WebSocketPair());
    server.accept(); server.binaryType = 'arraybuffer';
    const writer = tcpSocket.writable.getWriter();
    let closed = false, queued = 0, writes = Promise.resolve();
    const shutdown = (code = 1000, reason = 'TCP connection closed') => {
      if (closed) return;
      closed = true;
      try { server.close(code, reason); } catch {                      }
      tcpSocket.close().catch(() => {});
    };
    server.addEventListener('message', event => {
      if (closed) return;
      if (!(event.data instanceof ArrayBuffer)) { shutdown(1003, 'Binary messages required'); return; }
      const bytes = new Uint8Array(event.data);
      queued += bytes.byteLength;
      if (queued > LIMIT) { shutdown(1009, 'Write buffer limit exceeded'); return; }
      writes = writes.then(async () => {
        if (!closed) await writer.write(bytes);
        queued -= bytes.byteLength;
      }).catch(() => shutdown(1011, 'TCP write failed'));
    });
    server.addEventListener('close', () => shutdown());
    server.addEventListener('error', () => shutdown(1011, 'WebSocket failed'));
    tcpSocket.closed.catch(() => shutdown(1011, 'TCP connection failed'));

    void (async () => {
      const reader = tcpSocket.readable.getReader();
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          server.send(value);
        }
        shutdown();
      } catch { shutdown(1011, 'TCP read failed'); }
      finally { reader.releaseLock(); }
    })();
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'tcp-proxy' } });
  }
} satisfies ExportedHandler<Env>;
