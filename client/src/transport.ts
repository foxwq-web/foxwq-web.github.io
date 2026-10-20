import { Buffer } from "buffer";
import { encode, decodeOne, MAX_SIZE } from "./framing.ts";

import type { Frame } from "./framing.ts";
export interface Transport {
  closed?: boolean;
  send(command: number, payload: Uint8Array): void;
  close(): void;
  start?(): void;
}
export interface TransportOptions {
  proxyUrl: string;
  proxyToken: string;
}

export class Connection {
  ws: WebSocket;
  closed: boolean;
  buffer: Buffer;
  started: boolean;
  queued: Frame[];
  receive: (frame: Frame) => void;
  fail: (reason: string) => void;
  static async open(
    host: string,
    port: number,
    receive: (frame: Frame) => void,
    failed: (reason: string) => void,
    { proxyUrl, proxyToken }: TransportOptions,
  ) {
    const url = new URL(proxyUrl);
    if (!["wss:", "ws:"].includes(url.protocol))
      throw Error("Invalid proxy URL");
    if (
      url.protocol === "ws:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw Error("Use wss:// for the proxy");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(proxyToken))
      throw Error("Invalid proxy access token");
    url.pathname = "/proxy";
    url.search = "";
    url.searchParams.set("host", host);
    url.searchParams.set("port", String(port));

    const ws = new WebSocket(url, ["tcp-proxy", proxyToken]);
    ws.binaryType = "arraybuffer";
    const connection = new Connection(ws, receive, failed);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close();
        reject(Error("Proxy connection timed out"));
      }, 10000);
      const done = (callback: () => void) => {
        clearTimeout(timer);
        callback();
      };
      ws.addEventListener("open", () => done(resolve), { once: true });
      ws.addEventListener(
        "error",
        () => done(() => reject(Error("Proxy unreachable"))),
        { once: true },
      );
      ws.addEventListener(
        "close",
        () => done(() => reject(Error("Proxy closed before opening"))),
        { once: true },
      );
    });
    return connection;
  }
  constructor(
    ws: WebSocket,
    receive: (frame: Frame) => void,
    failed: (reason: string) => void,
  ) {
    this.ws = ws;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.started = false;
    this.queued = [];
    const fail = (reason: string) => {
      if (!this.closed) {
        this.close();
        failed(reason);
      }
    };
    ws.addEventListener("message", ({ data }) => {
      try {
        if (!(data instanceof ArrayBuffer))
          throw Error("Proxy sent a nonbinary message");
        this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
        if (this.buffer.length > MAX_SIZE + 65536)
          throw Error("receive buffer limit exceeded");
        let decoded;
        while ((decoded = decodeOne(this.buffer))) {
          const [frame, consumed] = decoded;
          this.buffer = this.buffer.subarray(consumed);
          if (this.started) receive(frame);
          else this.queued.push(frame);
        }
      } catch {
        fail("Invalid protocol response");
      }
    });
    ws.addEventListener("error", () => fail("Proxy unreachable"));
    ws.addEventListener("close", () => fail("Proxy connection closed"));
    this.receive = receive;
    this.fail = fail;
  }
  start() {
    this.started = true;
    try {
      for (const frame of this.queued.splice(0)) this.receive(frame);
    } catch {
      this.fail("Invalid protocol response");
    }
  }
  send(command: number, payload: Uint8Array) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      throw Error("connection closed");
    const packet = encode(command, payload, true);
    if (this.ws.bufferedAmount + packet.length > MAX_SIZE)
      throw Error("send buffer limit exceeded");
    this.ws.send(packet);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.queued = [];
    this.buffer = Buffer.alloc(0);
    this.ws.close();
  }
}
