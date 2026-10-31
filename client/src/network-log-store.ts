import type { NetworkEntry } from "./network-log";

export interface StoredNetworkEntry {
  key: string;
  entry: NetworkEntry;
}
export interface NetworkLogStore {
  readonly enabled?: boolean;
  readonly error?: string;
  put(record: StoredNetworkEntry): void;
  read(): StoredNetworkEntry[] | Promise<StoredNetworkEntry[]>;
  flush?(): void | Promise<void>;
}

export const NETWORK_LOG_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const WRITE_DELAY = 500;
interface Row extends StoredNetworkEntry { bytes: number }

const disabledStore: NetworkLogStore = {
  enabled: false,
  put() {},
  read: () => [],
};

export class IndexedDBNetworkLogStore implements NetworkLogStore {
  enabled = true;
  error?: string;
  private pending = new Map<string, Row>();
  private pendingBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, name = "fox-network-log", private maxBytes = NETWORK_LOG_MAX_BYTES) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 2);
      request.onupgradeneeded = () => {
        // Logs are disposable; rebuild the schema instead of migrating records.
        const db = request.result;
        for (const store of Array.from(db.objectStoreNames)) db.deleteObjectStore(store);
        db.createObjectStore("entries", { keyPath: "key" });
        db.createObjectStore("metadata");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("Network log database is blocked"));
      request.onsuccess = () => {
        const db = request.result;
        if (!this.enabled) { db.close(); return; }
        db.onversionchange = () => { this.disable(Error("Log database changed in another tab")); db.close(); };
        resolve(db);
      };
    });
    // Opening can fail before the first packet arrives.
    void this.database.catch(error => this.disable(error));
  }

  private disable(error: unknown) {
    if (!this.enabled) return;
    this.enabled = false;
    this.error = String(error);
    console.warn("Network log recording disabled. Reload the page to try again.", error);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.pendingBytes = 0;
  }

  put(record: StoredNetworkEntry) {
    if (!this.enabled) return;
    const bytes = JSON.stringify(record).length * 2;
    if (bytes > Math.min(MAX_PENDING_BYTES, this.maxBytes)) return;
    this.pendingBytes -= this.pending.get(record.key)?.bytes ?? 0;
    this.pending.set(record.key, { ...record, bytes });
    this.pendingBytes += bytes;
    // Debug logging may drop records if storage cannot keep up with traffic.
    while (this.pendingBytes > MAX_PENDING_BYTES) {
      const key = this.pending.keys().next().value!;
      this.pendingBytes -= this.pending.get(key)!.bytes;
      this.pending.delete(key);
    }
    if (this.timer === undefined && !this.writing) {
      this.timer = setTimeout(() => { void this.flush(); }, WRITE_DELAY);
      this.timer.unref?.();
    }
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled) return Promise.resolve();
    if (!this.writing) {
      this.writing = this.drain().catch(error => this.disable(error)).finally(() => {
        this.writing = undefined;
        if (this.enabled && this.pending.size) {
          this.timer = setTimeout(() => { void this.flush(); }, WRITE_DELAY);
          this.timer.unref?.();
        }
      });
    }
    return this.writing;
  }

  private async drain() {
    const db = await this.database;
    while (this.enabled && this.pending.size) {
      const rows = [...this.pending.values()];
      this.pending.clear();
      this.pendingBytes = 0;
      await new Promise<void>((resolve, reject) => {
        // Read/write transactions serialize accounting and eviction across tabs.
        const tx = db.transaction(["entries", "metadata"], "readwrite");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? Error("Network log storage transaction aborted"));
        const entries = tx.objectStore("entries"), metadata = tx.objectStore("metadata");
        const total = metadata.get("bytes");
        total.onsuccess = () => {
          let bytes: number = total.result ?? 0, remaining = rows.length;
          for (const row of rows) {
            const previous = entries.get(row.key);
            previous.onsuccess = () => {
              bytes += row.bytes - (previous.result?.bytes ?? 0);
              entries.put(row);
              if (--remaining) return;
              if (bytes <= this.maxBytes) metadata.put(bytes, "bytes");
              else {
                const oldest = entries.openCursor();
                oldest.onsuccess = () => {
                  const cursor = oldest.result;
                  if (bytes > this.maxBytes && cursor) {
                    bytes -= (cursor.value as Row).bytes;
                    cursor.delete();
                    cursor.continue();
                  } else metadata.put(bytes, "bytes");
                };
              }
            };
          }
        };
      });
    }
  }

  async read(): Promise<StoredNetworkEntry[]> {
    await this.flush();
    if (!this.enabled) return [];
    try {
      const db = await this.database;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("entries"), request = tx.objectStore("entries").getAll();
        tx.oncomplete = () => resolve((request.result as Row[]).map(({ key, entry }) => ({ key, entry })));
        tx.onabort = () => reject(tx.error ?? Error("Network log storage transaction aborted"));
      });
    } catch (error) {
      this.disable(error);
      return [];
    }
  }
}

export function networkLogStore(): NetworkLogStore {
  try {
    if (typeof indexedDB !== "undefined") return new IndexedDBNetworkLogStore(indexedDB);
  } catch { /* Debug logging is optional. */ }
  return disabledStore;
}
