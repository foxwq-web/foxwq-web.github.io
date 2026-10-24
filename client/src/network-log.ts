import { Buffer } from "buffer";
import { decodeOne, splitGateway } from "./framing.ts";
import { decode } from "./wire.ts";
import { GATEWAY } from "./game.ts";
import { networkLogStore, type NetworkLogStore, type StoredNetworkEntry } from "./network-log-store";

export interface NetworkEntry {
  timestamp: string;
  source: string;
  destination: string;
  payload: string;
}
interface PendingChunk extends StoredNetworkEntry {
  remaining: number;
  redacted: boolean;
}
interface Stream {
  buffer: Buffer;
  chunks: PendingChunk[];
  invalid: boolean;
}

export class NetworkLog {
  private readonly pageId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  private sequence = 0;
  private connections = new Map<number, { client: string; server: string }>();
  private streams = new Map<string, Stream>();
  constructor(private store: NetworkLogStore = networkLogStore()) {}

  connection(host: string, port: number) {
    const id = this.connections.size + 1;
    this.connections.set(id, { client: `client:${this.pageId}:${id}`, server: `${host}:${port}` });
    return id;
  }
  private recording() { return this.store.enabled !== false; }
  flush() { return this.store.flush?.(); }

  private finish(stream: Stream) {
    for (const chunk of stream.chunks) {
      this.store.put({ key: chunk.key, entry: { ...chunk.entry, payload: "" } });
    }
    stream.chunks = [];
    stream.buffer = Buffer.alloc(0);
  }
  closeConnection(connectionId: number) {
    for (const direction of ["inbound", "outbound"]) {
      const key = `${connectionId}:${direction}`;
      const stream = this.streams.get(key);
      if (stream) this.finish(stream);
      this.streams.delete(key);
    }
  }
  traffic(connectionId: number, direction: "inbound" | "outbound", bytes: Uint8Array) {
    if (!this.recording()) { this.streams.clear(); return; }
    const { client, server } = this.connections.get(connectionId)!;
    const timestamp = new Date().toISOString();
    const chunk: PendingChunk = {
      key: `${timestamp}:${this.pageId}:${String(this.sequence++).padStart(16, "0")}`,
      entry: {
        timestamp,
        source: direction === "outbound" ? client : server,
        destination: direction === "outbound" ? server : client,
        payload: Buffer.from(bytes).toString("base64"),
      },
      remaining: bytes.length,
      redacted: false,
    };
    const streamKey = `${connectionId}:${direction}`;
    const stream = this.streams.get(streamKey) ?? { buffer: Buffer.alloc(0), chunks: [], invalid: false };
    this.streams.set(streamKey, stream);
    stream.chunks.push(chunk);
    stream.buffer = Buffer.concat([stream.buffer, bytes]);
    if (stream.invalid) { this.finish(stream); return; }
    try {
      let decoded;
      while ((decoded = decodeOne(stream.buffer))) {
        const [frame, size] = decoded;
        let sensitive = frame.command === 2000 || frame.command === 2005;
        if (frame.command === 26200) {
          try {
            const [header] = splitGateway(frame.payload);
            const message = decode(header);
            sensitive = message.number(7) === GATEWAY && message.number(1) === 1;
          } catch { sensitive = true; }
        }
        stream.buffer = stream.buffer.subarray(size);
        let remaining = size;
        for (const pending of stream.chunks) {
          const consumed = Math.min(pending.remaining, remaining);
          if (consumed && sensitive) pending.redacted = true;
          pending.remaining -= consumed;
          remaining -= consumed;
          if (!remaining) break;
        }
        while (stream.chunks[0]?.remaining === 0) {
          const completed = stream.chunks.shift()!;
          this.store.put({ key: completed.key, entry: { ...completed.entry, payload: completed.redacted ? "" : completed.entry.payload } });
        }
      }
    } catch {
      stream.invalid = true;
      this.finish(stream);
    }
  }
  async serialize() {
    if (!this.recording()) { this.streams.clear(); return "[]"; }
    const pending = [...this.streams.values()].flatMap(stream => stream.chunks.map(chunk => ({
      key: chunk.key, entry: { ...chunk.entry, payload: "" },
    })));
    let stored: StoredNetworkEntry[] = [];
    try { stored = await this.store.read(); }
    catch (error) {
      console.warn("Network log could not read browser storage.", error);
    }
    if (!this.recording()) { this.streams.clear(); return "[]"; }
    const records = new Map(stored.map(record => [record.key, record]));
    for (const record of pending) records.set(record.key, record);
    return JSON.stringify([...records.values()].sort((a, b) => a.key.localeCompare(b.key)).map(record => record.entry));
  }
}
