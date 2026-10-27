import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';
import { encode as frame, gatewayPayload } from '../src/framing.ts';
import { encode, decode, type Fields } from '../src/wire.ts';
import { envelope, unpack } from '../src/game.ts';
import type { NetworkEntry } from '../src/network-log.ts';
import { normalizeLog, packets, inferAction, identify, MAC, PASSWORD } from './integration/log.ts';
import { comparePacket } from './integration/replay.ts';
import { loginRequest } from '../src/session.ts';

const fixture: NetworkEntry[] = JSON.parse(await readFile(new URL('./integration/fixtures/fox-network-log-20261020T0851.network.json', import.meta.url), 'utf8'));
const gateway = (service: number, op: number, fields = {}) => packets([{ ...fixture[5], payload: frame(26200, envelope(42, service, op, fields), true).toString('base64') }])[0].frame;

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
  for (const index of [0, 1, 5, 9]) redacted[index].payload = '';
  const result = normalizeLog(redacted), decoded = packets(result.entries);
  assert.equal(result.synthetic, true);
  assert.equal(decode(decoded[1].frame.payload).number(2), decode(packets(fixture)[1].frame.payload).number(2));
  assert.deepEqual(decoded[0].frame.payload, loginRequest('Replay player', PASSWORD, MAC));
  assert.equal(unpack(decoded[5].frame.payload)[1].text(1), 'offline-replay-token');
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
    const [header, body] = unpack(packet.frame.payload), key = packet.outbound ? 3 : 2;
    const fields: Fields = Object.fromEntries([...body].map(([key, values]) => [key, values]));
    fields[key] = `player-${Number(body.text(key).split('-')[1]) + 17}`;
    changed[packet.index].payload = frame(26200, gatewayPayload(encode(Object.fromEntries([...header].map(([key, values]) => [key, values]))), encode(fields)), true).toString('base64');
  }
  // Re-encoding a real server response can choose compression differently.
  const decodedBodies = (entries: NetworkEntry[]) => packets(entries).map(packet => packet.frame.payload.toString('base64'));
  assert.deepEqual(decodedBodies(normalizeLog(changed).entries), decodedBodies(fixture));
  const login = decode(packets(changed)[0].frame.payload);
  const fields = Object.fromEntries([...login].map(([key, values]) => [key, values]));
  fields[5] = [999];
  changed[0].payload = frame(2000, encode(fields), true).toString('base64');
  assert.equal(decode(packets(normalizeLog(changed).entries)[0].frame.payload).number(5), 999,
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

test('replay infers UI actions from protocol requests and leaves automatic packets alone', () => {
  for (const [packet, action] of [
    [gateway(30006, 100130, { 1: 101 }), { type: 'match', id: 101 }],
    [gateway(30006, 100139), { type: 'cancel' }],
    [gateway(31000, 201, { 1: 3, 2: 15 }), { type: 'play', x: 3, y: 15 }],
    [gateway(31000, 204), { type: 'pass' }],
    [gateway(31000, 301), { type: 'count' }],
    [gateway(31000, 304, { 1: true }), { type: 'confirm', accept: true }],
    [gateway(31000, 304, { 1: false }), { type: 'confirm', accept: false }],
    [gateway(31000, 311), { type: 'resign' }],
  ] as const) assert.deepEqual(inferAction(packet), action);
  assert.equal(inferAction(gateway(20001, 5)), null);
  assert.equal(inferAction(gateway(31000, 501)), null);
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
    assert.equal(createHash('sha256').update(JSON.stringify(server)).digest('hex'), recording.serverEntriesSha256, recording.fixture);
  }
});
