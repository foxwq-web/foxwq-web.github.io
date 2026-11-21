import { Buffer } from "buffer";
import { netMsgToBytes, extractNetMsgFromBytes, MAX_SIZE } from "./framing.ts";

import type { NetMsg } from "./framing.ts";
import type { NetworkLog } from "./network-log.ts";
export interface Transport {
  closed?: boolean;
  send(command: number, payload: Uint8Array): void;
  close(reason?: string): void;
  start?(): void;
}
export interface TransportOptions {
  proxyUrl: string;
  proxyToken: string;
  networkLog?: NetworkLog;
}

export class Connection {
  networkLog?: NetworkLog;
  connectionId?: number;
  ws: WebSocket;
  closed: boolean;
  buffer: Buffer;
  started: boolean;
  queued: NetMsg[];
  receive: (frame: NetMsg) => void;
  fail: (reason: string) => void;
  static async open(
    host: string,
    port: number,
    receive: (frame: NetMsg) => void,
    failed: (reason: string) => void,
    { proxyUrl, proxyToken, networkLog }: TransportOptions,
  ) {
    const url = new URL(proxyUrl);
    if (!["wss:", "ws:"].includes(url.protocol))
      throw Error("invalid proxy url");
    if (
      url.protocol === "ws:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw Error("use wss for the proxy");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(proxyToken))
      throw Error("invalid proxy access token");
    url.pathname = "/proxy";
    url.search = "";
    url.searchParams.set("host", host);
    url.searchParams.set("port", String(port));
    const connectionId = networkLog?.connection(host, port);
    const diagnosticId = crypto.randomUUID();
    url.searchParams.set("connection_id", diagnosticId);


    const ws = new WebSocket(url, ["tcp-proxy", proxyToken]);
    ws.binaryType = "arraybuffer";
    const connection = new Connection(ws, receive, failed, {
      networkLog,
      connectionId,
      diagnosticId,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close("proxy connection timed out");
        reject(Error("proxy connection timed out"));
      }, 10000);
      const done = (callback: () => void) => {
        clearTimeout(timer);
        callback();
      };
      ws.addEventListener("open", () => done(resolve), { once: true });
      ws.addEventListener(
        "error",
        () => done(() => reject(Error("proxy unreachable"))),
        { once: true },
      );
      ws.addEventListener(
        "close",
        () => done(() => reject(Error("proxy closed before opening"))),
        { once: true },
      );
    });
    return connection;
  }
  constructor(
    ws: WebSocket,
    receive: (frame: NetMsg) => void,
    failed: (reason: string) => void,
    {
      networkLog,
      connectionId,
      diagnosticId,
    }: { networkLog?: NetworkLog; connectionId?: number; diagnosticId?: string } = {},
  ) {
    this.networkLog = networkLog;
    this.connectionId = connectionId;
    this.diagnosticId = diagnosticId;
    this.ws = ws;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.started = false;
    this.queued = [];
    this.diagnostic("connecting");
    ws.addEventListener("open", () => this.diagnostic("open"), { once: true });
    ws.addEventListener("error", () => this.diagnostic("websocket_error"));
    const environmentChanged = () => this.diagnostic("browser_state");
    if (diagnosticId) {
      globalThis.addEventListener?.("online", environmentChanged);
      globalThis.addEventListener?.("offline", environmentChanged);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", environmentChanged);
      this.removeDiagnosticListeners = () => {
        globalThis.removeEventListener?.("online", environmentChanged);
        globalThis.removeEventListener?.("offline", environmentChanged);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", environmentChanged);
      };
    }
    const fail = (reason: string) => {
      if (!this.closed) {
        this.diagnostic("failure", reason);
        this.close(reason);
        failed(reason);
      }
    };
    ws.addEventListener("message", ({ data }) => {
      try {
        if (!(data instanceof ArrayBuffer))
          throw Error("proxy sent a nonbinary message");
        this.receivedBytes += data.byteLength;
        this.lastReceivedAt = performance.now();
        this.networkLog?.traffic(
          this.connectionId!,
          "inbound",
          Buffer.from(data),
        );
        this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
        if (this.buffer.length > MAX_SIZE + 65536)
          throw Error("receive buffer limit exceeded");
        let decoded;
        while ((decoded = extractNetMsgFromBytes(this.buffer))) {
          const [frame, consumed] = decoded;
          this.buffer = this.buffer.subarray(consumed);
          if (this.started) receive(frame);
          else this.queued.push(frame);
        }
      } catch {
        fail("invalid protocol response");
      }
    });
    // A WebSocket error is followed by close; wait for its diagnostic details.
    ws.addEventListener("close", ({ code, reason, wasClean }) => {
      this.diagnostic("close", `code ${code}${reason ? ` ${reason}` : ""}; clean ${wasClean}`);
      this.removeDiagnosticListeners?.();
      if (this.connectionId !== undefined)
        this.networkLog?.closeConnection(this.connectionId, { code, reason, wasClean });
      fail(`proxy connection closed code ${code}${reason ? ` ${reason}` : ""}`);
    }, { once: true });
    this.receive = receive;
    this.fail = fail;
  }
  start() {
    this.started = true;
    try {
      for (const frame of this.queued.splice(0)) this.receive(frame);
    } catch {
      this.fail("invalid protocol response");
    }
  }
  send(command: number, payload: Uint8Array) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      throw Error("connection closed");
    const packet = netMsgToBytes(command, payload, true);
    if (this.ws.bufferedAmount + packet.length > MAX_SIZE)
      throw Error("send buffer limit exceeded");
    this.ws.send(packet);
    this.sentBytes += packet.length;
    this.lastSentAt = performance.now();
    this.networkLog?.traffic(this.connectionId!, "outbound", packet);
  }
  private diagnosticId?: string;
  private createdAt = performance.now();
  private sentBytes = 0;
  private receivedBytes = 0;
  private lastSentAt: number | null = null;
  private lastReceivedAt: number | null = null;
  private localCloseReason?: string;
  private removeDiagnosticListeners?: () => void;
  private diagnostic(event: string, reason?: string) {
    if (!this.diagnosticId || !this.networkLog || this.connectionId === undefined) return;
    const time = performance.now();
    this.networkLog.diagnostic(this.connectionId, {
      connectionId: this.diagnosticId, event, elapsedMs: Math.round(time - this.createdAt),
      sentBytes: this.sentBytes, receivedBytes: this.receivedBytes,
      lastSentAgoMs: this.lastSentAt === null ? null : Math.round(time - this.lastSentAt),
      lastReceivedAgoMs: this.lastReceivedAt === null ? null : Math.round(time - this.lastReceivedAt),
      bufferedBytes: this.ws.bufferedAmount, readyState: this.ws.readyState,
      online: typeof navigator === "undefined" ? null : navigator.onLine ?? null,
      visibility: typeof document === "undefined" ? null : document.visibilityState,
      ...(reason ? { reason } : {}),
      ...(this.localCloseReason ? { localCloseReason: this.localCloseReason } : {}),
    });
  }
  close(reason = "client close") {
    if (this.closed) return;
    if (this.ws.readyState < 2) {
      this.localCloseReason = reason;
      this.diagnostic("close_requested", reason);
    }
    this.closed = true;
    this.removeDiagnosticListeners?.();
    this.queued = [];
    this.buffer = Buffer.alloc(0);
    if (this.connectionId !== undefined) this.networkLog?.closeConnection(this.connectionId);
    this.ws.close();
  }
}
