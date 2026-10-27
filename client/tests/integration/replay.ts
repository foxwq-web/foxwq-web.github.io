import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import type { Browser } from 'playwright';
import { unpack, GATEWAY } from '../../src/game.ts';
import { decodeOne } from '../../src/framing.ts';
import type { NetworkEntry } from '../../src/network-log.ts';
import { act, installReplay, uiSnapshot, type SentPacket } from './browser.ts';
import { address, identify, inferAction, normalizeLog, packets, PASSWORD, type Packet } from './log.ts';

export interface ReplayResult { snapshot: Awaited<ReturnType<typeof uiSnapshot>>; entries: NetworkEntry[]; discarded: number; synthetic: boolean }

export function comparePacket(expected: Packet, actual: SentPacket) {
  const expectedBytes = Buffer.from(expected.payload, 'base64'), actualBytes = Buffer.from(actual.payload, 'base64');
  if (actual.connection === expected.connection && expectedBytes.equals(actualBytes)) return;
  let offset = 0;
  while (offset < Math.min(expectedBytes.length, actualBytes.length) && expectedBytes[offset] === actualBytes[offset]) offset++;
  const decoded = decodeOne(actualBytes);
  throw Error(`Entry ${expected.index + 1} (${expected.timestamp}), ${expected.connection}: outbound ${identify(expected.frame)} differs at byte ${offset}.\n` +
    `Expected ${expectedBytes.length} bytes; actual ${actualBytes.length} bytes (${decoded ? identify(decoded[0]) : 'invalid frame'}) on ${actual.connection}.\n` +
    `Expected base64: ${expected.payload}\nActual base64:   ${actual.payload}`);
}

export async function replay(browser: Browser, url: string, input: unknown, updateMessages = false): Promise<ReplayResult> {
  const normalized = normalizeLog(input), sequence = packets(normalized.entries);
  const channels = [...new Map(sequence.filter(packet => packet.outbound).map(packet => [packet.connection, { id: packet.connection, address: address(packet) }])).values()];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors: string[] = [];
  page.setDefaultTimeout(3000);
  page.on('pageerror', error => errors.push(error.message));
  // No real proxy, Fox HTTP request, or other remote resource can escape.
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    if (new URL(route.request().url()).pathname === '/fox/chessbook/TXWQFetchChessList')
      return route.fulfill({ json: { result: 0, chesslist: [] } });
    errors.push(`Unexpected HTTP request: ${route.request().url()}`);
    return route.abort();
  });
  let time = Date.parse(sequence[0].timestamp);
  const result: NetworkEntry[] = [];
  const heartbeatClocks: ({ ticks: number; time: number } | undefined)[] = [];
  let upcomingClock: { ticks: number; time: number } | undefined;
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (sequence[i].outbound && identify(sequence[i].frame) === `${GATEWAY}/5`)
      upcomingClock = { ticks: unpack(sequence[i].frame.payload)[1].number(1), time: Date.parse(sequence[i].timestamp) };
    heartbeatClocks[i] = upcomingClock;
  }
  const settle = () => page.evaluate(async () => {
    // Flush browser tasks and React effects without sleeps or advancing time.
    for (let i = 0; i < 2; i++) await new Promise<void>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
  });
  const pending = () => page.evaluate(() => window.__networkReplay.sent);
  const shift = () => page.evaluate(() => window.__networkReplay.sent.shift()!);
  const append = (sent: SentPacket, timestamp: string) => {
    const channel = channels.find(channel => channel.id === sent.connection);
    assert.ok(channel, `Unexpected replay connection ${sent.connection}`);
    result.push({ timestamp, source: sent.connection, destination: channel.address, payload: sent.payload });
  };
  try {
    await page.clock.install({ time: time - 60_000 });
    await context.addInitScript(`globalThis.__name = value => value; (${installReplay.toString()})(${JSON.stringify({ channels })});`);
    await page.goto(url);
    await page.locator('#username').waitFor();
    await page.clock.pauseAt(time);
    let lastHeartbeat: { ticks: number; time: number } | undefined;
    for (const packet of sequence) {
      const clock = heartbeatClocks[packet.index] ?? lastHeartbeat;
      if (clock) {
        await page.evaluate(ticks => { window.__networkReplay.ticks = ticks; }, clock.ticks);
      }
      const nextTime = Date.parse(packet.timestamp);
      await page.clock.runFor(nextTime - time);
      time = nextTime;
      await settle();
      if (clock && (packet.outbound || identify(packet.frame) !== `${GATEWAY}/1`))
        await page.evaluate(ticks => { window.__networkReplay.ticks = ticks; }, clock.ticks + time - clock.time);
      if (packet.outbound && identify(packet.frame) === `${GATEWAY}/5`) lastHeartbeat = clock;
      if (!packet.outbound) {
        // Socket open latency and independent inbound streams can place server
        // frames before an already queued send. Strict mode compares that send
        // at its recorded outbound entry; it must not consume or discard it.
        if (updateMessages) while ((await pending()).length) append(await shift(), packet.timestamp);
        await page.evaluate(({ connection, payload }) => window.__networkReplay.deliver(connection, payload), packet);
        await settle();
        if (identify(packet.frame) === `${GATEWAY}/1`)
          await page.evaluate(() => window.__networkReplay.captureHeartbeat());
        result.push(normalized.entries[packet.index]);
        continue;
      }
      const expectedId = identify(packet.frame);
      // In update mode retain newly generated automatic messages and remove old
      // automatic requests that no longer exist. UI actions are still required.
      if (updateMessages) {
        while ((await pending()).length) {
          const first = (await pending())[0];
          if (identify(decodeOne(Buffer.from(first.payload, 'base64'))![0]) === expectedId) break;
          // Keep packets matching a later expected output for that later step.
          const later = sequence.slice(packet.index + 1).find(candidate => !candidate.outbound || identify(candidate.frame) === identify(decodeOne(Buffer.from(first.payload, 'base64'))![0]));
          if (later?.outbound) break;
          append(await shift(), packet.timestamp);
        }
      }
      let queued = await pending();
      const action = inferAction(packet.frame);
      if ((!queued.length || (updateMessages && identify(decodeOne(Buffer.from(queued[0].payload, 'base64'))![0]) !== expectedId)) && action) {
        const before = queued.length;
        await act(page, action, normalized.username, PASSWORD);
        await settle();
        queued = await pending();
        if (queued.length <= before) throw Error(`Entry ${packet.index + 1}: inferred ${action.type} produced no client packet.`);
      }
      if (!queued.length && expectedId === `${GATEWAY}/5`) {
        // Run the actual production timer callback at the recorded dispatch.
        if (clock) await page.evaluate(ticks => { window.__networkReplay.ticks = ticks; }, clock.ticks);
        await page.evaluate(() => window.__networkReplay.fireHeartbeat());
        await settle();
        queued = await pending();
      }
      if (!queued.length) {
        if (updateMessages && !action) continue;
        throw Error(`Entry ${packet.index + 1}: no outbound ${expectedId}. No supported UI action or timer produced this packet.`);
      }
      if (updateMessages && !action && identify(decodeOne(Buffer.from(queued[0].payload, 'base64'))![0]) !== expectedId) continue;
      const actual = await shift();
      if (!updateMessages) comparePacket(packet, actual);
      append(actual, packet.timestamp);
    }
    await settle();
    const remaining = await pending();
    if (remaining.length && !updateMessages) throw Error(`End of log: ${remaining.length} unexpected outbound packet(s).`);
    while ((await pending()).length) append(await shift(), sequence.at(-1)!.timestamp);
    errors.push(...await page.evaluate(() => window.__networkReplay.errors));
    assert.deepEqual(errors, [], 'Browser or network errors during replay');
    return { snapshot: await uiSnapshot(page), entries: result, discarded: normalized.discarded, synthetic: normalized.synthetic };
  } finally { await context.close(); }
}
