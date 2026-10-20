import { setupFoxGame } from './fox-game.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import type { NetworkEntry } from '../src/network-log.ts';
import type { StoredNetworkEntry, NetworkLogStore } from '../src/network-log-store.ts';
import { NetworkLog } from '../src/network-log.ts';
import { Connection } from '../src/transport.ts';
import { Session, loginRequest } from '../src/session.ts';
import { encode, decode } from '../src/wire.ts';
import { decodeOne, encode as frame } from '../src/framing.ts';
import { GATEWAY, GAME, envelope } from '../src/game.ts';
import SparkMD5 from 'spark-md5';

test('network-only export preserves one timestamp/source/destination/payload per wire chunk', () => {
  const log = new NetworkLog();
  const first = log.connection('fox.example',10000), second = log.connection('fox.example',10000);
  const bytes = frame(3005, Buffer.from([0,1,255]));
  log.traffic(first,'outbound',bytes); log.traffic(first,'inbound',bytes); log.traffic(second,'inbound',bytes);
  const json = log.serialize(), exported = JSON.parse(json);
  assert.ok(Array.isArray(exported));
  assert.equal(exported.length, 3);
  assert.equal(json.includes('\n'), false);
  for (const entry of exported) {
    assert.deepEqual(Object.keys(entry), ['timestamp','source','destination','payload']);
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
    assert.deepEqual(Buffer.from(entry.payload,'base64'),bytes);
  }
  assert.match(exported[0].source,/^client:.+:1$/); assert.equal(exported[0].destination,'fox.example:10000');
  assert.equal(exported[1].source,'fox.example:10000'); assert.equal(exported[1].destination,exported[0].source);
  assert.match(exported[2].destination,/^client:.+:2$/);
  const session = new Session(); session.networkLog = log;
  session.close();
  assert.deepEqual(JSON.parse(log.serialize()), exported);
});

test('malformed incoming traffic is recorded once but redacted before storage', () => {
  const log = new NetworkLog(), connectionId = log.connection('fox.example',10000);
  const ws = Object.assign(new EventTarget(), { close() {} });
  let failure;
  const connection = new Connection(ws as unknown as WebSocket, () => assert.fail('must not deliver malformed frame'), reason => {failure=reason;},
    {networkLog:log,connectionId});
  const bytes = Buffer.from('000707d00001b800d9','hex');
  for (const part of [bytes.subarray(0,3),bytes.subarray(3)])
    ws.dispatchEvent(new MessageEvent('message',{data:Uint8Array.from(part).buffer}));
  const entries: NetworkEntry[] = JSON.parse(log.serialize());
  assert.equal(entries.length, 2);
  assert.ok(entries.every(e=>e.payload === ''));
  assert.equal(entries[0].source,'fox.example:10000'); assert.match(entries[0].destination,/^client:.+:1$/);
  assert.equal(failure,'Invalid protocol response'); assert.equal(connection.closed,true);
});

test('exports redact login credentials and tokens across compressed, split and coalesced frames', () => {
  const username = 'private-login-name', password = 'private-login-password';
  const token = Buffer.from('private-session-token'.repeat(20));
  const secrets = [username, password, SparkMD5.hash(password), token.toString()];
  const packets: ["inbound" | "outbound", Buffer][] = [
    ['outbound', frame(2000, loginRequest(username, password), true)],
    ['inbound', frame(2005, encode({1:0,2:42,8:token}), true)],
    ['outbound', frame(26200, envelope(42, GATEWAY, 1, {1:token}), true)],
  ];
  const ordinary = frame(26200, envelope(42, GAME, 200, {1:100}));
  for (const [direction, packet] of packets) {
    for (const split of [1, 3, packet.length - 1, packet.length]) {
      const originalPacket = Buffer.from(packet);
      const log = new NetworkLog(), connection = log.connection('fox.example', 10000);
      log.traffic(connection, direction, packet.subarray(0, split));
      log.traffic(connection, direction, Buffer.concat([packet.subarray(split), ordinary]));
      log.traffic(connection, direction, ordinary);
      const exported: NetworkEntry[] = JSON.parse(log.serialize());
      assert.equal(exported[0].payload, '');
      if (split < packet.length) {
        assert.equal(exported[1].payload, '');
      } else assert.equal(exported[1].payload, ordinary.toString('base64'));
      assert.equal(exported[2].payload, ordinary.toString('base64'));
      for (const secret of secrets) {
        assert.equal(log.serialize().includes(secret), false);
        assert.ok(exported.every(e=>!Buffer.from(e.payload, 'base64').includes(Buffer.from(secret))));
      }
      assert.deepEqual(packet, originalPacket,
        'capture must not mutate traffic sent to Fox');
    }
  }
});

test('partial authentication frames are redacted even before their remainder arrives', () => {
  const log = new NetworkLog(), connection = log.connection('fox.example', 10000);
  const packet = frame(2000, loginRequest('private-name', 'private-password'));
  log.traffic(connection, 'outbound', packet.subarray(0, packet.length - 1));
  assert.equal(JSON.parse(log.serialize())[0].payload, '');
  log.traffic(connection, 'outbound', packet.subarray(packet.length - 1));
  assert.ok((JSON.parse(log.serialize()) as NetworkEntry[]).every(e=>!e.payload));
});

test('complete non-authentication frames retain their original chunk boundaries', () => {
  const log = new NetworkLog(), connection = log.connection('fox.example', 10000);
  const packet = frame(3005, encode({1:42}), true);
  const chunks = [packet.subarray(0,3), packet.subarray(3)];
  for (const chunk of chunks) log.traffic(connection, 'inbound', chunk);
  assert.deepEqual((JSON.parse(log.serialize()) as NetworkEntry[]).map(e=>e.payload), chunks.map(c=>c.toString('base64')));
});

test('accepted outgoing frames are recorded once and decode offline; failed sends are excluded', () => {
  const log = new NetworkLog(), connectionId = log.connection('fox.example',10000);
  const sent: Uint8Array[] = [];
  const ws = Object.assign(new EventTarget(), { close() {}, readyState: 1, bufferedAmount: 0, send(bytes: Uint8Array) { sent.push(bytes); } });
  const connection = new Connection(ws as unknown as WebSocket,()=>{},()=>{}, {networkLog:log,connectionId});
  const original = globalThis.WebSocket; globalThis.WebSocket = {OPEN:1} as typeof WebSocket;
  try {
    const payload = Buffer.alloc(5000,97);
    connection.send(3000,payload);
    const entries: NetworkEntry[] = JSON.parse(log.serialize());
    assert.equal(entries.length,1);
    const bytes = Buffer.from(entries[0].payload,'base64'); assert.deepEqual(bytes,sent[0]);
    const [packet,size] = decodeOne(bytes)!;
    assert.equal(size,bytes.length); assert.equal(packet.command,3000); assert.deepEqual(packet.payload,payload);
    ws.send=()=>{throw Error('rejected');}; assert.throws(()=>connection.send(2000,Buffer.alloc(0)),/rejected/);
    assert.equal(JSON.parse(log.serialize()).length,1);
  } finally {globalThis.WebSocket=original;connection.close();}
});

test('SGF eligibility requires a completed game and survives disconnect', () => {
  const session = new Session();
  assert.equal(session.snapshot().game_over, false);
  setupFoxGame(session);
  session.gameMessage(206, decode(encode({})), decode(encode({})));
  session.gameMessage(206, decode(encode({})), decode(encode({})));
  assert.equal(session.snapshot().game_over, false, 'two passes await the server result');
  session.gameMessage(402, decode(encode({ 2: 1, 4: 3 })), decode(encode({})));
  assert.equal(session.snapshot().game_over, true);
  session.close(); assert.equal(session.snapshot().game_over, true);
  setupFoxGame(session);
  session.gameMessage(402, decode(encode({ 2: 1, 4: 3 })), decode(encode({})));
  assert.equal(session.snapshot().game_over, true);
  session.gameMessage(501, decode(encode({ 6: 3 })), decode(encode({})));
  assert.equal(session.snapshot().game_over, false, 'restoring an active game hides SGF');
  session.gameMessage(501, decode(encode({ 6: 5 })), decode(encode({})));
  assert.equal(session.snapshot().game_over, true, 'restoring a finished game enables SGF');
});

test('directional fragments retain capture order at equal timestamps and never persist secrets', () => {
  const records = new Map<string, StoredNetworkEntry>();
  const store: NetworkLogStore = {put(record) {records.set(record.key,record);}, read() {return [...records.values()];}};
  const log = new NetworkLog(store), connection = log.connection('fox.example',10000);
  const packet = frame(3005, encode({1:42}));
  log.traffic(connection,'inbound',packet.subarray(0,3));
  log.traffic(connection,'outbound',packet);
  log.traffic(connection,'inbound',packet.subarray(3));
  assert.deepEqual((JSON.parse(log.serialize()) as NetworkEntry[]).map(e=>e.payload), [packet.subarray(0,3),packet,packet.subarray(3)].map(b=>b.toString('base64')));
  log.traffic(connection,'outbound',frame(2000,loginRequest('private-user','private-password')));
  assert.equal([...records.values()].at(-1)!.entry.payload,'');
  const previous = JSON.parse(log.serialize());
  assert.deepEqual(JSON.parse(new NetworkLog(store).serialize()), previous, 'stored traffic survives a new page logger');
});
