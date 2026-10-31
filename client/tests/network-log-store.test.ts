import test from "node:test";
import assert from "node:assert/strict";
import { IndexedDBNetworkLogStore, networkLogStore } from "../src/network-log-store";
import { NetworkLog } from "../src/network-log";
import { netMsgToBytes } from "../src/framing";

test("unsupported storage disables network capture without an in-memory fallback", async () => {
  assert.equal(typeof indexedDB, "undefined");
  const store = networkLogStore();
  assert.equal(store.enabled, false);
  const log = new NetworkLog(store), connection = log.connection("fox", 10000);
  const packet = netMsgToBytes(3005, new Uint8Array(1024));
  for (let i = 0; i < 1000; i++) log.traffic(connection, "inbound", packet);
  assert.equal(await log.serialize(), "[]");
  assert.deepEqual(await store.read(), []);
});

test("database open failure warns once with the cause without affecting traffic", async context => {
  const warning = context.mock.method(console, "warn", () => {});
  const failure = new DOMException("denied", "SecurityError");
  const store = new IndexedDBNetworkLogStore({
    open() { throw failure; },
  } as unknown as IDBFactory);
  store.put({ key: "test", entry: { timestamp: "", source: "", destination: "", payload: "" } });
  await store.flush();
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.read(), []);
  const log = new NetworkLog(store), connection = log.connection("fox", 10000);
  log.traffic(connection, "inbound", netMsgToBytes(3005, new Uint8Array(100)));
  assert.equal(await log.serialize(), "[]");
  assert.equal(log.error, "SecurityError: denied");
  await store.flush();
  assert.equal(warning.mock.callCount(), 1);
  assert.match(warning.mock.calls[0].arguments[0], /Network log recording disabled/);
  assert.equal(warning.mock.calls[0].arguments[1], failure);
});
