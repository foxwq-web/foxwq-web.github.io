import type { NetworkEntry } from "./network-log";

export interface StoredNetworkEntry {
  key: string;
  entry: NetworkEntry;
}
export interface NetworkLogStore {
  put(record: StoredNetworkEntry): void;
  read(): StoredNetworkEntry[];
  flush?(): void;
}

export const NETWORK_LOG_KEY = "fox-network-log";
export const NETWORK_LOG_MAX_BYTES = 20 * 1024 * 1024;
const WRITE_DELAY = 500;
type Row = [key: string, source: string, destination: string, payload: string];
interface CachedEntry {
  record: StoredNetworkEntry;
  json: string;
}

class MemoryStore implements NetworkLogStore {
  protected records: CachedEntry[] = [];
  private bytes = 4; // JSON array brackets, in UTF-16 bytes.

  put(record: StoredNetworkEntry) {
    const encode = (value: StoredNetworkEntry) => JSON.stringify([
      value.key, value.entry.source, value.entry.destination, value.entry.payload,
    ] satisfies Row);
    let json = encode(record);
    // Keep metadata when a single payload would consume the whole log.
    if ((json.length + 2) * 2 > NETWORK_LOG_MAX_BYTES) {
      record = { key: record.key, entry: { ...record.entry, payload: "" } };
      json = encode(record);
      if ((json.length + 2) * 2 > NETWORK_LOG_MAX_BYTES) return;
    }
    // Fragments can complete out of capture order; normally this just appends.
    let low = 0, high = this.records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.records[middle].record.key.localeCompare(record.key) < 0) low = middle + 1;
      else high = middle;
    }
    if (this.records[low]?.record.key === record.key) {
      this.bytes -= (this.records[low].json.length + 1) * 2;
      this.records.splice(low, 1);
    }
    this.records.splice(low, 0, { record, json });
    this.bytes += (json.length + 1) * 2;
    while (this.bytes > NETWORK_LOG_MAX_BYTES) this.dropOldest();
  }
  protected dropOldest() {
    const removed = this.records.shift()!;
    this.bytes -= (removed.json.length + 1) * 2;
  }
  read(): StoredNetworkEntry[] { return this.records.map(({ record }) => record); }
}

export class LocalStorageNetworkLogStore extends MemoryStore {
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private disabled = false;
  private warned = false;

  constructor(private storage: Pick<Storage, "getItem" | "setItem">) {
    super();
    try {
      const saved = storage.getItem(NETWORK_LOG_KEY) ?? "[]";
      const rows: Row[] = JSON.parse(saved);
      for (const [key, source, destination, payload] of rows) {
        super.put({ key, entry: { timestamp: key.slice(0, 24), source, destination, payload } });
      }
      if (saved.length * 2 > NETWORK_LOG_MAX_BYTES) {
        this.dirty = true;
        this.flush();
      }
    } catch (error) { this.unavailable(error); }
  }
  override put(record: StoredNetworkEntry) {
    super.put(record);
    this.dirty = true;
    if (!this.disabled && this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), WRITE_DELAY);
      this.timer.unref?.();
    }
  }
  override read() {
    this.flush();
    return super.read();
  }
  private unavailable(error: unknown) {
    const quota = error instanceof DOMException && error.name === "QuotaExceededError";
    this.disabled = !quota;
    if (!this.warned) {
      this.warned = true;
      console.warn("Network log storage unavailable; a bounded log remains in memory until this page closes.", error);
    }
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty || this.disabled) return;
    this.dirty = false;
    const write = (skip: number) => this.storage.setItem(
      NETWORK_LOG_KEY, `[${this.records.slice(skip).map(({ json }) => json).join(",")}]`,
    );
    try { write(0); return; }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") {
        this.unavailable(error);
        return;
      }
    }
    // A smaller browser quota (or other origin data) may require extra eviction.
    // Never erase saved history if even the newest record cannot fit.
    let low = 1, high = this.records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      try { write(middle); high = middle; }
      catch (error) {
        if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") {
          this.unavailable(error);
          return;
        }
        low = middle + 1;
      }
    }
    if (low === this.records.length) {
      this.unavailable(new DOMException("Network record exceeds available localStorage", "QuotaExceededError"));
      return;
    }
    try {
      write(low);
      for (let i = 0; i < low; i++) this.dropOldest();
    } catch (error) { this.unavailable(error); }
  }
}

export function networkLogStore(): NetworkLogStore {
  try {
    if (typeof window !== "undefined" && typeof localStorage !== "undefined")
      return new LocalStorageNetworkLogStore(localStorage);
  } catch (error) {
    console.warn("Network log localStorage unavailable; a bounded log remains in memory until this page closes.", error);
  }
  return new MemoryStore();
}
