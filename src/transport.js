import { Buffer } from 'buffer';
import { encode, decodeOne, MAX_SIZE } from './framing.js';

// Each WebSocket carries a byte stream, not a sequence of FOX packets.
export class Connection {
  static async open(host, port, receive, failed, { proxyUrl, proxyToken }) {
    const url = new URL(proxyUrl);
    if (!['wss:', 'ws:'].includes(url.protocol)) throw Error('Invalid proxy URL');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Use wss:// for the proxy');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(proxyToken)) throw Error('Invalid proxy access token');
    url.pathname = '/proxy'; url.search = '';
    url.searchParams.set('host', host); url.searchParams.set('port', port);
    // Browsers cannot set Authorization on a WebSocket upgrade. The Worker
    // authenticates the second offered subprotocol and only echoes the first.
    const ws = new WebSocket(url, ['tcp-proxy', proxyToken]);
    ws.binaryType = 'arraybuffer';
    const connection = new Connection(ws, receive, failed);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.close(); reject(Error('Proxy connection timed out')); }, 10000);
      const done = callback => { clearTimeout(timer); callback(); };
      ws.addEventListener('open', () => done(resolve), { once: true });
      ws.addEventListener('error', () => done(() => reject(Error('Proxy connection failed'))), { once: true });
      ws.addEventListener('close', () => done(() => reject(Error('Proxy closed before opening'))), { once: true });
    });
    return connection;
  }
  constructor(ws, receive, failed) {
    this.ws = ws; this.closed = false; this.buffer = Buffer.alloc(0); this.started = false; this.queued = [];
    const fail = reason => { if (!this.closed) { this.close(); failed(reason); } };
    ws.addEventListener('message', ({ data }) => {
      try {
        if (!(data instanceof ArrayBuffer)) throw Error('Proxy sent a nonbinary message');
        this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
        if (this.buffer.length > MAX_SIZE + 65536) throw Error('receive buffer limit exceeded');
        let decoded;
        while ((decoded = decodeOne(this.buffer))) {
          const [frame, consumed] = decoded;
          this.buffer = this.buffer.subarray(consumed);
          if (this.started) receive(frame);
          else this.queued.push(frame);
        }
      } catch { fail('Invalid FOX packet or protocol response'); }
    });
    ws.addEventListener('error', () => fail('Worker proxy connection failed'));
    ws.addEventListener('close', () => fail('FOX proxy connection closed'));
    this.receive = receive; this.fail = fail;
  }
  start() {
    this.started = true;
    try { for (const frame of this.queued.splice(0)) this.receive(frame); }
    catch { this.fail('Invalid FOX protocol response'); }
  }
  send(command, payload) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw Error('connection closed');
    const packet = encode(command, payload, true);
    if (this.ws.bufferedAmount + packet.length > MAX_SIZE) throw Error('send buffer limit exceeded');
    this.ws.send(packet);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.queued = []; this.buffer = Buffer.alloc(0);
    this.ws.close();
  }
}
