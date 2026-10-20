import test from "node:test";
import assert from "node:assert/strict";
import { LocalStorageNetworkLogStore, NETWORK_LOG_KEY, NETWORK_LOG_MAX_BYTES, networkLogStore, type StoredNetworkEntry } from "../src/network-log-store";
import { NetworkLog } from "../src/network-log";
import { encode } from "../src/framing";

function storage(quota: number) {
  const data = new Map<string, string>([["preference", "keep me"]]);
  return {
    data,
    getItem(key: string) { return data.get(key) ?? null; },
    setItem(key: string, value: string) {
      const next = new Map(data).set(key, value);
      const size = [...next].reduce((n, [k, v]) => n + (k.length + v.length) * 2, 0);
      if (size > quota) throw new DOMException("full", "QuotaExceededError");
      data.set(key, value);
    },
  };
}
// A thousand records must exceed the cap even when its configured size changes.
const retentionPayload = "a".repeat(Math.ceil(NETWORK_LOG_MAX_BYTES / 1000));

function record(sequence: number, payload = "Ynl0ZXM="): StoredNetworkEntry {
  const timestamp = "2020-01-01T00:00:00.000Z";
  return {key: `${timestamp}:test:${String(sequence).padStart(16,"0")}`, entry: {timestamp,source:"client:test:1",destination:"fox:10000",payload}};
}

test("localStorage retains everything that fits and trims only the oldest records when full", () => {
  const local = storage(4000), store = new LocalStorageNetworkLogStore(local);
  const all = Array.from({length: 100}, (_, i) => record(i));
  for (const item of all) store.put(item);
  const kept = store.read();
  assert.ok(kept.length > 1 && kept.length < all.length);
  assert.deepEqual(kept, all.slice(-kept.length));
  assert.equal(local.data.get("preference"), "keep me");
  const rows = JSON.parse(local.data.get(NETWORK_LOG_KEY)!);
  const prior = all[all.length-kept.length-1];
  rows.unshift([prior.key,prior.entry.source,prior.entry.destination,prior.entry.payload]);
  assert.throws(() => local.setItem(NETWORK_LOG_KEY,JSON.stringify(rows)), {name:"QuotaExceededError"}, "retaining one more record would exceed the real quota");
  assert.deepEqual(new LocalStorageNetworkLogStore(local).read(),kept);
});

test("a game worth of network records fits in the bounded log", () => {
  const local = storage(5*1024*1024), store = new LocalStorageNetworkLogStore(local);
  for (let i=0; i<2000; i++) store.put(record(i));
  assert.equal(store.read().length,2000);
});

test("storage denial does not interrupt traffic and unsaved entries remain downloadable", () => {
  const local = storage(1000), store = new LocalStorageNetworkLogStore(local);
  store.put(record(0));
  store.flush();
  const saved = local.data.get(NETWORK_LOG_KEY);
  const log = new NetworkLog(store), connection = log.connection("fox",10000);
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    const packet = encode(3005,new Uint8Array(2000));
    log.traffic(connection,"inbound",packet);
    assert.equal(local.data.get(NETWORK_LOG_KEY),saved,"oversized packet must not erase saved history");
    const entries = JSON.parse(log.serialize());
    assert.equal(entries.length,2);
    assert.ok(entries.some((entry: {payload: string}) => entry.payload === Buffer.from(packet).toString("base64")));
    assert.equal(warnings.length,1);
  } finally { console.warn = original; }
});

test("packet bursts read storage once and persist as a single batch", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const local = storage(5 * 1024 * 1024);
  let reads = 0, writes = 0;
  const store = new LocalStorageNetworkLogStore({
    getItem(key) { reads++; return local.getItem(key); },
    setItem(key, value) { writes++; local.setItem(key, value); },
  });
  for (let i = 0; i < 2000; i++) store.put(record(i));
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  context.mock.timers.tick(499);
  assert.equal(writes, 0);
  context.mock.timers.tick(1);
  assert.equal(writes, 1);
  assert.equal(store.read().length, 2000);
  assert.equal(reads, 1);
  assert.equal(writes, 1, "clean reads do not rewrite the log");
  store.put(record(2000));
  store.flush();
  assert.equal(writes, 2);
  context.mock.timers.tick(500);
  assert.equal(writes, 2, "explicit flushing cancels the scheduled write");
  assert.equal(new LocalStorageNetworkLogStore(local).read().length, 2001);
});

test("retained logs stay bounded in storage and in the memory-only fallback", () => {
  const local = storage(3 * NETWORK_LOG_MAX_BYTES);
  const stores = [new LocalStorageNetworkLogStore(local), networkLogStore()];
  for (const store of stores) {
    for (let i = 0; i < 1000; i++) store.put(record(i, retentionPayload));
    const kept = store.read();
    assert.ok(kept.length > 0 && kept.length < 1000);
    assert.deepEqual(kept.at(-1), record(999, retentionPayload));
    const rows = kept.map(({key, entry}) => [key, entry.source, entry.destination, entry.payload]);
    assert.ok(JSON.stringify(rows).length * 2 <= NETWORK_LOG_MAX_BYTES);
    store.put(record(1000, "a".repeat(NETWORK_LOG_MAX_BYTES)));
    assert.equal(store.read().at(-1)!.entry.payload, "", "oversized payloads retain only metadata");
  }
  assert.ok(local.data.get(NETWORK_LOG_KEY)!.length * 2 <= NETWORK_LOG_MAX_BYTES);
});

test("persistent storage denial keeps a bounded, downloadable log without retrying every packet", () => {
  let writes = 0;
  const original = console.warn;
  console.warn = () => {};
  try {
    const store = new LocalStorageNetworkLogStore({
      getItem() { return null; },
      setItem() { writes++; throw new DOMException("denied", "SecurityError"); },
    });
    store.put(record(0));
    store.flush();
    for (let i = 1; i <= 1000; i++) store.put(record(i, retentionPayload));
    const kept = store.read();
    assert.equal(writes, 1);
    assert.ok(kept.length > 0 && kept.length < 1000);
    assert.deepEqual(kept.at(-1), record(1000, retentionPayload));
  } finally { console.warn = original; }
});

test("loading an older oversized log applies the size bound immediately", () => {
  const local = storage(3 * NETWORK_LOG_MAX_BYTES);
  const rows = Array.from({length: 1000}, (_, i) => {
    const {key, entry} = record(i, retentionPayload);
    return [key, entry.source, entry.destination, entry.payload];
  });
  local.setItem(NETWORK_LOG_KEY, JSON.stringify(rows));
  const store = new LocalStorageNetworkLogStore(local);
  assert.ok(local.data.get(NETWORK_LOG_KEY)!.length * 2 <= NETWORK_LOG_MAX_BYTES);
  const kept = store.read();
  assert.ok(kept.length > 0 && kept.length < rows.length);
  assert.deepEqual(kept.at(-1), record(999, retentionPayload));
});

test("out-of-order completion and replacement preserve chronological retention", () => {
  const local = storage(5 * 1024 * 1024), store = new LocalStorageNetworkLogStore(local);
  for (const i of [3, 1, 2, 0]) store.put(record(i));
  store.put(record(2, "updated"));
  assert.deepEqual(store.read(), [record(0), record(1), record(2, "updated"), record(3)]);
});
