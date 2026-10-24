import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const url = process.env.FOX_BROWSER_URL!;
const selected = (process.env.FOX_LOG_BROWSERS ?? "chromium").split(",");
for (const engine of [chromium, firefox, webkit].filter(engine => selected.includes(engine.name()))) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value;");
    const page = await context.newPage();
    await page.goto(url);
    const result = await page.evaluate(async () => {
      const path = "/src/network-log-store.ts", logPath = "/src/network-log.ts", framingPath = "/src/framing.ts";
      const { IndexedDBNetworkLogStore } = await import(path);
      const { NetworkLog } = await import(logPath);
      const { encode } = await import(framingPath);
      function check(value: unknown, message: string) { if (!value) throw Error(message); }
      const record = (i: number, payload = "bytes") => ({
        key: `2026-01-01T00:00:00.000Z:test:${String(i).padStart(16, "0")}`,
        entry: { timestamp: "2026-01-01T00:00:00.000Z", source: "client:test:1", destination: "fox:10000", payload },
      });
      const name = crypto.randomUUID();
      const store = new IndexedDBNetworkLogStore(indexedDB, name, 12000);
      for (const i of [3, 1, 2, 0]) store.put(record(i));
      store.put(record(2, "updated"));
      let saved = await store.read();
      check(saved.map((r: { key: string }) => r.key).join() === [0, 1, 2, 3].map(i => record(i).key).join(), "chronological order");
      check(saved[2].entry.payload === "updated", "replacement before flush");
      store.put(record(2, "replaced after flush"));
      await store.flush();
      // Reopening uses the same committed records, without a full in-memory cache.
      const other = new IndexedDBNetworkLogStore(indexedDB, name, 12000);
      check((await other.read())[2].entry.payload === "replaced after flush", "reload persistence");
      for (let i = 4; i < 100; i++) (i % 2 ? store : other).put(record(i, "x".repeat(100)));
      await Promise.all([store.flush(), other.flush()]);
      saved = await store.read();
      const bytes = saved.reduce((n: number, r: ReturnType<typeof record>) => n + JSON.stringify(r).length * 2, 0);
      check(bytes <= 12000 && saved.length > 1 && saved.length < 100, "shared retention budget");
      check(saved.at(-1).key === record(99).key, "newest record retained");
      // Every record more recent than the first retained key must survive both writers.
      const first = Number(saved[0].key.split(":").at(-1));
      check(saved.length === 100 - first, "concurrent writers do not lose records");
      check(JSON.stringify(saved) === JSON.stringify(await other.read()), "both connections see the same records");
      const beforeOversized = JSON.stringify(saved);
      store.put(record(100, "x".repeat(13000)));
      check(JSON.stringify(await store.read()) === beforeOversized, "oversized debug records are dropped");

      const burst = new IndexedDBNetworkLogStore(indexedDB, crypto.randomUUID());
      for (let i = 0; i < 1500; i++) burst.put(record(i, "x".repeat(1000)));
      const bounded = await burst.read();
      check(bounded.length > 0 && bounded.length < 1500, "pending queue is bounded while database opens");
      check(bounded.at(-1).key === record(1499).key, "pending queue keeps newest records");

      const redactedStore = new IndexedDBNetworkLogStore(indexedDB, crypto.randomUUID());
      const log = new NetworkLog(redactedStore), connection = log.connection("fox", 10000);
      const secret = new TextEncoder().encode("private-login-and-token");
      const auth = encode(2000, secret, true), normal = encode(3005, new Uint8Array([1, 2, 3]));
      log.traffic(connection, "outbound", auth.subarray(0, 3));
      check(JSON.parse(await log.serialize())[0].payload === "", "partial authentication export is redacted");
      log.traffic(connection, "outbound", auth.subarray(3));
      log.traffic(connection, "inbound", normal);
      const exported = JSON.parse(await log.serialize());
      check(exported.length === 3 && exported[0].payload === "" && exported[1].payload === "", "authentication never persists");
      check(exported[2].payload !== "", "ordinary traffic persists");
      check((await redactedStore.read()).length === 3, "download awaits committed writes");

      // An aborted write must disable storage, release pending records, and resolve callers.
      const realOpen = indexedDB.open.bind(indexedDB);
      const failing = new IndexedDBNetworkLogStore({ open(dbName: string, version: number) {
        const request = realOpen(dbName, version);
        request.addEventListener("success", () => {
          const db = request.result, transaction = db.transaction.bind(db);
          db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
            const tx = transaction(...args);
            if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
            return tx;
          }) as IDBDatabase["transaction"];
        });
        return request;
      } }, crypto.randomUUID());
      failing.put(record(1));
      await failing.flush();
      check(!failing.enabled && (await failing.read()).length === 0, "storage failure disables logging");
      return { bytes, retained: saved.length, pendingRetained: bounded.length, name };
    });
    assert.ok(result.retained > 1);
    // Two actual documents share a database; no page can overwrite the other's log.
    const second = await context.newPage();
    await second.goto(url);
    const write = async (target: typeof page, suffix: string) => target.evaluate(async ({ name, suffix }) => {
      const path = "/src/network-log-store.ts";
      const { IndexedDBNetworkLogStore } = await import(path);
      const store = new IndexedDBNetworkLogStore(indexedDB, name, 12000);
      store.put({ key: `2027:${suffix}`, entry: { timestamp: "2027", source: suffix, destination: "fox", payload: "" } });
      await store.flush();
    }, { name: result.name, suffix });
    await Promise.all([write(page, "first"), write(second, "second")]);
    const sources = await page.evaluate(async name => {
      const path = "/src/network-log-store.ts";
      const { IndexedDBNetworkLogStore } = await import(path);
      return (await new IndexedDBNetworkLogStore(indexedDB, name, 12000).read()).map((r: { entry: { source: string } }) => r.entry.source);
    }, result.name);
    assert.ok(sources.includes("first") && sources.includes("second"));
    console.log(`${engine.name()}: IndexedDB retention, concurrent tabs, reload, redaction, bounded pending writes, and aborted storage passed`);
  } finally { await browser.close(); }
}
