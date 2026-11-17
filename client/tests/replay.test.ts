import { GAME_SVR, GAME_SVR_MGR, RoomMessageID, SVR_TYPE_FGW, LegacyMsgTypeID } from "../src/protocol.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';
import { netMsgToBytes as frame, encodeFgwPacket } from '../src/framing.ts';
import { encode, decode, type Fields } from '../src/wire.ts';
import { encodeFgwMessage, decodeFgwMessage } from '../src/game.ts';
import type { NetworkEntry } from '../src/network-log.ts';
import { normalizeLog, packets, inferAction, identify, MAC, PASSWORD } from './integration/log.ts';
import { comparePacket } from './integration/replay.ts';
import { loginRequest } from '../src/session.ts';

const fixture: NetworkEntry[] = JSON.parse(await readFile(new URL('./integration/fixtures/fox-network-log-20261020T0851.network.json', import.meta.url), 'utf8'));
const gateway = (service: number, op: number, fields = {}) => packets([{ ...fixture[5], payload: frame(LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET, encodeFgwMessage(42, service, op, fields), true).toString('base64') }])[0].frame;

test('replay starts at the last login and ignores older traffic, clocks and connections', () => {
  const old = fixture.map(entry => ({ ...entry, source: entry.source.replace('client:', 'client:old-'), destination: entry.destination.replace('client:', 'client:old-') }));
  const stale = { ...old.at(-1)!, timestamp: fixture.at(-1)!.timestamp };
  const input = [...old, ...fixture, stale];
  const result = normalizeLog(input);
  assert.equal(result.discarded, old.length);
  assert.deepEqual(result.entries, fixture);
  assert.equal(result.synthetic, false);
});

test('replay reconstructs redacted login and gateway authentication with deterministic credentials', () => {
  const redacted = fixture.map(entry => ({ ...entry }));
  for (const packet of packets(fixture)) {
    if ([2000, 2005, 4000, 4005].includes(packet.frame.msgTypeID) || identify(packet.frame) === '20001/1') redacted[packet.index].payload = '';
  }
  const result = normalizeLog(redacted), decoded = packets(result.entries);
  assert.equal(result.synthetic, true);
  assert.equal(decode(decoded[1].frame.rawProto).number(2), decode(packets(fixture)[1].frame.rawProto).number(2));
  assert.deepEqual(decoded[0].frame.rawProto, loginRequest('Replay player', PASSWORD, MAC));
  assert.equal(decodeFgwMessage(decoded.find(packet => packet.outbound && identify(packet.frame) === '20001/1')!.frame.rawProto)[1].text(1), 'offline-replay-token');
  assert.deepEqual(normalizeLog(result.entries).entries, result.entries, 'normalization is idempotent');
  assert.throws(() => normalizeLog([...redacted, { ...redacted.at(-1)!, payload: '' }]), /non-bootstrap/);
});

test('replay assembles fragmented frames and splits coalesced frames in stream order', () => {
  const bytes = Buffer.from(fixture[2].payload, 'base64');
  const fragmented = [
    ...fixture.slice(0, 2),
    { ...fixture[2], payload: bytes.subarray(0, 3).toString('base64') },
    { ...fixture[2], payload: bytes.subarray(3).toString('base64') },
    ...fixture.slice(3),
  ];
  assert.deepEqual(normalizeLog(fragmented).entries, fixture);
  const coalesced = [...fixture.slice(0, 2), {
    ...fixture[3], payload: Buffer.concat([Buffer.from(fixture[2].payload, 'base64'), Buffer.from(fixture[3].payload, 'base64')]).toString('base64'),
  }, ...fixture.slice(4)];
  const result = normalizeLog(coalesced).entries;
  assert.deepEqual(result.map(entry => entry.payload), fixture.map(entry => entry.payload));
});

test('normalization renumbers tab-lifetime player request IDs and preserves unrelated protocol fields', () => {
  const changed = fixture.map(entry => ({ ...entry }));
  for (const packet of packets(changed)) {
    if (identify(packet.frame) !== '20043/1001') continue;
    const [header, body] = decodeFgwMessage(packet.frame.rawProto), key = packet.outbound ? 3 : 2;
    const fields: Fields = Object.fromEntries([...body].map(([key, values]) => [key, values]));
    fields[key] = `player-${Number(body.text(key).split('-')[1]) + 17}`;
    changed[packet.index].payload = frame(LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET, encodeFgwPacket(encode(Object.fromEntries([...header].map(([key, values]) => [key, values]))), encode(fields)), true).toString('base64');
  }
  // Re-encoding a real server response can choose compression differently.
  const decodedBodies = (entries: NetworkEntry[]) => packets(entries).map(packet => packet.frame.rawProto.toString('base64'));
  assert.deepEqual(decodedBodies(normalizeLog(changed).entries), decodedBodies(fixture));
  const login = decode(packets(changed)[0].frame.rawProto);
  const fields = Object.fromEntries([...login].map(([key, values]) => [key, values]));
  fields[5] = [999];
  changed[0].payload = frame(2000, encode(fields), true).toString('base64');
  assert.equal(decode(packets(normalizeLog(changed).entries)[0].frame.rawProto).number(5), 999,
    'normalizing credentials must not bless changes to the client protocol version');
});

test('replay rejects invalid, incomplete, absent-login and unreconstructible logs', () => {
  for (const value of [null, [], {}, [{ payload: '' }]]) assert.throws(() => normalizeLog(value), /Expected|Invalid/);
  assert.throws(() => normalizeLog(fixture.slice(10)), /No login/);
  assert.throws(() => normalizeLog([{ ...fixture[0], payload: '' }]), /No login/);
  assert.throws(() => normalizeLog([...fixture, { ...fixture.at(-1)!, payload: 'bad base64!' }]), /base64/);
  assert.throws(() => normalizeLog([...fixture, { ...fixture.at(-1)!, payload: Buffer.of(0).toString('base64') }]), /Truncated/);
  assert.throws(() => normalizeLog([...fixture, { ...fixture.at(-1)!, payload: '' }]), /non-bootstrap/);
  assert.throws(() => normalizeLog([...fixture, { ...fixture.at(-1)!, timestamp: '2020-01-01T00:00:00Z' }]), /chronological/);
});

test('normalization renumbers player request IDs and matches out-of-order replies', () => {
  const messages = [
    [true, { 1: 42, 3: 'player-19' }],
    [true, { 1: 43, 3: 'player-20' }],
    [false, { 1: 0, 2: 'player-20', 3: 43, 5: 532905654 }],
    [false, { 1: 0, 2: 'player-19', 3: 42 }],
  ] as const;
  const input = [...fixture.slice(0, 10), ...messages.map(([out, body]) => ({
    ...fixture.at(-1)!, source: out ? fixture[5].source : fixture[5].destination,
    destination: out ? fixture[5].destination : fixture[5].source,
    payload: frame(26200, encodeFgwMessage(42, 20043, 1001, body), true).toString('base64'),
  }))];
  const normalized = normalizeLog(input).entries;
  assert.deepEqual(packets(normalized).slice(-4).map(packet => decodeFgwMessage(packet.frame.rawProto)[1].text(packet.outbound ? 3 : 2)),
    ['player-1', 'player-2', 'player-2', 'player-1']);
  assert.deepEqual(normalizeLog(normalized).entries, normalized);
  assert.equal(decodeFgwMessage(packets(normalized).at(-2)!.frame.rawProto)[1].number(5), 532905654);
});

test('replay infers UI actions from protocol requests and leaves automatic packets alone', () => {
  for (const [packet, action] of [
    [gateway(GAME_SVR_MGR, RoomMessageID.RM_AUTO_INVITE_REQUEST, { 1: 101 }), { type: 'match', id: 101 }],
    [gateway(GAME_SVR, 201, { 1: 3, 2: 15 }), { type: 'play', x: 3, y: 15 }],
    [gateway(GAME_SVR, 204), { type: 'pass' }],
    [gateway(GAME_SVR, 301), { type: 'count' }],
    [gateway(GAME_SVR, 304, { 1: true }), { type: 'confirm', accept: true }],
    [gateway(GAME_SVR, 304, { 1: false }), { type: 'confirm', accept: false }],
    [gateway(GAME_SVR, 311), { type: 'resign' }],
  ] as const) assert.deepEqual(inferAction(packet), action);
  assert.equal(inferAction(gateway(SVR_TYPE_FGW, 5)), null);
  assert.equal(inferAction(gateway(GAME_SVR, 501)), null);
  assert.equal(inferAction(gateway(20043, 1001, { 1: 42, 3: 'player-1' })), null);
  assert.deepEqual(inferAction(packets(fixture)[0].frame), { type: 'login' });
});

test('outbound comparison checks every byte and the connection, with packet diagnostics', () => {
  const expected = packets(fixture)[2];
  comparePacket(expected, expected);
  assert.equal(identify(expected.frame), '3000');
  const wrong = { ...expected, payload: frame(3000, encode({ 1: 43, 2: false }), true).toString('base64') };
  assert.throws(() => comparePacket(expected, wrong), /Entry 3.*outbound 3000 differs at byte/);
  assert.throws(() => comparePacket(expected, { ...expected, connection: 'wrong' }), /on wrong/);
});

// Guard the real inbound recordings even when client traffic is regenerated.
test('recorded server entries retain their imported bytes, order and timestamps', async () => {
  const provenance = JSON.parse(await readFile(new URL('./integration/fixtures/provenance.json', import.meta.url), 'utf8'));
  for (const recording of provenance) {
    const entries: NetworkEntry[] = JSON.parse(await readFile(new URL(`./integration/fixtures/${recording.fixture}`, import.meta.url), 'utf8'));
    const server = entries.filter(entry => !entry.source.startsWith('client:'));
    const digest = (entries: NetworkEntry[]) => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    assert.equal(digest(server), recording.serverEntriesSha256, recording.fixture);
    if (recording.classicBootstrap) {
      const synthetic = [...(recording.syntheticLobbyResponses?.entries ?? [])].map((entry: NetworkEntry) => JSON.stringify(entry));
      const imported = server.filter(entry => {
        if (entry.destination.endsWith(':pc')) return false;
        const index = synthetic.indexOf(JSON.stringify(entry));
        if (index === -1) return true;
        synthetic.splice(index, 1);
        return false;
      });
      assert.equal(synthetic.length, 0, `${recording.fixture}: documented synthetic replies must remain present`);
      assert.equal(digest(imported), recording.classicBootstrap.originalServerEntriesSha256,
        `${recording.fixture}: historical server traffic must survive synthetic PC bootstrap additions`);
    }
  }
});
