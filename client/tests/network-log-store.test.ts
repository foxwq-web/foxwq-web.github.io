import test from "node:test";
import assert from "node:assert/strict";
import { IndexedDBNetworkLogStore, networkLogStore } from "../src/network-log-store";
import { NetworkLog } from "../src/network-log";
import { encode } from "../src/framing";

test("unsupported storage disables network capture without an in-memory fallback", async () => {
  assert.equal(typeof indexedDB, "undefined");
  const store = networkLogStore();
  assert.equal(store.enabled, false);
  const log = new NetworkLog(store), connection = log.connection("fox", 10000);
  const packet = encode(3005, new Uint8Array(1024));
  for (let i = 0; i < 1000; i++) log.traffic(connection, "inbound", packet);
  assert.equal(await log.serialize(), "[]");
  assert.deepEqual(await store.read(), []);
});

test("database open failure disables logging without affecting traffic", async () => {
  const store = new IndexedDBNetworkLogStore({
    open() { throw new DOMException("denied", "SecurityError"); },
  } as unknown as IDBFactory);
  store.put({ key: "test", entry: { timestamp: "", source: "", destination: "", payload: "" } });
  await store.flush();
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.read(), []);
  const log = new NetworkLog(store), connection = log.connection("fox", 10000);
  log.traffic(connection, "inbound", encode(3005, new Uint8Array(100)));
  assert.equal(await log.serialize(), "[]");
});
