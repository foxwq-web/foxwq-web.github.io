import type { NetworkEntry } from "./network-log";
import { onPersistenceChange, persistenceAllowed } from "./persistence";

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
  private clearing?: Promise<void>;
  private revision = 0;
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
      request.onblocked = () => reject(Error("network log database is blocked"));
      request.onsuccess = () => {
        const db = request.result;
        if (!this.enabled) { db.close(); return; }
        db.onversionchange = () => { this.disable(Error("log database changed in another tab")); db.close(); };
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
    console.warn("network log recording disabled reload the page to try again", error);
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
    const revision = this.revision;
    await this.clearing;
    const db = await this.database;
    while (this.enabled && revision === this.revision && this.pending.size) {
      const rows = [...this.pending.values()];
      this.pending.clear();
      this.pendingBytes = 0;
      await new Promise<void>((resolve, reject) => {
        // Read/write transactions serialize accounting and eviction across tabs.
        const tx = db.transaction(["entries", "metadata"], "readwrite");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? Error("network log storage transaction aborted"));
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

  clear(): Promise<void> {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.pendingBytes = 0;
    const writing = this.writing;
    const clearing = this.clearing;
    return this.clearing = (async () => {
      await clearing;
      await writing;
      if (!this.enabled) return;
      const db = await this.database;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["entries", "metadata"], "readwrite");
        tx.objectStore("entries").clear();
        tx.objectStore("metadata").clear();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    })().catch(error => this.disable(error));
  }

  async read(): Promise<StoredNetworkEntry[]> {
    await this.flush();
    if (!this.enabled) return [];
    try {
      const db = await this.database;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("entries"), request = tx.objectStore("entries").getAll();
        tx.oncomplete = () => resolve((request.result as Row[]).map(({ key, entry }) => ({ key, entry })));
        tx.onabort = () => reject(tx.error ?? Error("network log storage transaction aborted"));
      });
    } catch (error) {
      this.disable(error);
      return [];
    }
  }
}

let persistentStore: IndexedDBNetworkLogStore | undefined;
onPersistenceChange(allowed => {
  if (!allowed) {
    if (persistentStore) void persistentStore.clear();
    else {
      try { indexedDB.deleteDatabase("fox-network-log"); } catch {}
    }
  }
});
function activeStore(): NetworkLogStore {
  if (!persistenceAllowed()) return disabledStore;
  try {
    if (typeof indexedDB !== "undefined") return persistentStore ??= new IndexedDBNetworkLogStore(indexedDB);
  } catch { /* Debug logging is optional. */ }
  return disabledStore;
}
const managedStore: NetworkLogStore = {
  get enabled() { return activeStore().enabled; },
  get error() { return persistenceAllowed() ? activeStore().error : "network logging is disabled while remember me is off"; },
  put(record) { activeStore().put(record); },
  read() { return activeStore().read(); },
  flush() { return activeStore().flush?.(); },
};
export function networkLogStore(): NetworkLogStore { return managedStore; }
