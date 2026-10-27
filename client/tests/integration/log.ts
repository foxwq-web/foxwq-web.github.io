import { Buffer } from 'buffer';
import SparkMD5 from 'spark-md5';
import { decodeOne, encode as frame, gatewayPayload, type Frame } from '../../src/framing.ts';
import { decode, encode, type Fields } from '../../src/wire.ts';
import { unpack, GATEWAY, ROOM, GAME } from '../../src/game.ts';
import type { NetworkEntry } from '../../src/network-log.ts';

// Authentication is deliberately synthetic: exported logs have no credentials
// or login responses, and an MD5 password cannot be turned back into UI input.
export const PASSWORD = 'network-replay';
export const MAC = '000000000000';
const TOKEN = Buffer.from('offline-replay-token');
export interface Packet extends NetworkEntry {
  connection: string;
  outbound: boolean;
  frame: Frame;
  index: number;
}
interface RecordEntry extends NetworkEntry { index: number }
const fieldsOf = (message: ReturnType<typeof decode>): Fields => Object.fromEntries([...message].map(([key, values]) => [key, values]));
const login = (username: string) => encode({ 1: username, 2: 'foxwq', 3: SparkMD5.hash(PASSWORD), 4: 8, 5: 11509231, 6: false, 7: MAC, 9: false });

export function outbound(entry: NetworkEntry) { return entry.source.startsWith('client:'); }
export function connection(entry: NetworkEntry) { return outbound(entry) ? entry.source : entry.destination; }
export function address(entry: NetworkEntry) { return outbound(entry) ? entry.destination : entry.source; }

export function identify(packet: Frame) {
  if (packet.command !== 26200) return String(packet.command);
  const [header] = unpack(packet.payload);
  return `${header.number(7)}/${header.number(1)}`;
}

function records(input: unknown): RecordEntry[] {
  if (!Array.isArray(input) || !input.length) throw Error('Expected a nonempty network-log JSON array.');
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' ||
      !['timestamp', 'source', 'destination', 'payload'].every(key => typeof entry[key] === 'string') ||
      !Number.isFinite(Date.parse(entry.timestamp)) ||
      entry.source.startsWith('client:') === entry.destination.startsWith('client:'))
      throw Error(`Invalid network-log entry ${index + 1}.`);
    return { ...entry, index };
  });
}

// Complete frames are ordered by the chunk that completed them. This preserves
// causality across connections, including fragmented and coalesced TCP data.
function deframe(entries: RecordEntry[]) {
  const streams = new Map<string, Buffer>();
  const result: (RecordEntry & { frame?: Frame; error?: string })[] = [];
  for (const entry of entries) {
    const key = `${connection(entry)}:${outbound(entry)}`;
    if (!entry.payload) { result.push(entry); continue; }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.payload)) {
      result.push({ ...entry, error: 'Invalid base64 payload' }); continue;
    }
    let buffer = Buffer.concat([streams.get(key) ?? Buffer.alloc(0), Buffer.from(entry.payload, 'base64')]);
    try {
      let decoded;
      while ((decoded = decodeOne(buffer))) {
        const [packet, size] = decoded;
        result.push({ ...entry, frame: packet, payload: buffer.subarray(0, size).toString('base64') });
        buffer = buffer.subarray(size);
      }
    } catch (error) {
      result.push({ ...entry, error: String(error) }); buffer = Buffer.alloc(0);
    }
    streams.set(key, buffer);
  }
  for (const [key, buffer] of streams) {
    if (buffer.length) {
      const last = [...entries].reverse().find(entry => `${connection(entry)}:${outbound(entry)}` === key)!;
      result.push({ ...last, error: 'Truncated frame at end of log' });
    }
  }
  return result.sort((a, b) => a.index - b.index);
}

export function normalizeLog(input: unknown): { entries: NetworkEntry[]; username: string; discarded: number; synthetic: boolean } {
  const entries = records(input), decoded = deframe(entries);
  const nav = new Set(decoded.filter(entry => entry.frame && [2000, 2005, 3000, 3005, 3010, 3015].includes(entry.frame.command)).map(connection));
  const candidates = decoded.filter(entry => outbound(entry) &&
    (entry.frame?.command === 2000 || (!entry.payload && nav.has(connection(entry)))));
  // Consecutive empty chunks on one stream belong to one redacted auth frame.
  const starts = candidates.filter((entry, i) => entry.frame || !i || connection(candidates[i - 1]) !== connection(entry));
  const start = starts.at(-1);
  if (!start) throw Error('No login sequence found. Include a complete login and discovery sequence in the log.');
  const firstSeen = new Map<string, number>();
  for (const entry of entries) if (!firstSeen.has(connection(entry))) firstSeen.set(connection(entry), entry.index);
  const allowed = new Set(entries.filter(entry => entry.index >= start.index && outbound(entry) &&
    (connection(entry) === connection(start) || firstSeen.get(connection(entry))! >= start.index)).map(connection));
  const retained = decoded.filter(entry => entry.index >= start.index && allowed.has(connection(entry)));
  const invalid = retained.find(entry => entry.error);
  if (invalid) throw Error(`Entry ${invalid.index + 1}: ${invalid.error}`);
  const loginResponse = retained.find(entry => entry.frame?.command === 2005)?.frame;
  let uid = loginResponse ? decode(loginResponse.payload).number(2) || decode(loginResponse.payload).sub(3).number(1) : 0;
  for (const entry of retained) {
    if (uid || !entry.frame || !outbound(entry)) continue;
    if (entry.frame.command === 3000) uid = decode(entry.frame.payload).number(1);
    else if (entry.frame.command === 26200) uid = unpack(entry.frame.payload)[0].number(3);
  }
  const request = start.frame ? decode(start.frame.payload) : null;
  const response = loginResponse ? decode(loginResponse.payload) : null;
  const username = request?.text(1) || response?.sub(3).text(3) || response?.sub(3).text(2) || 'Replay player';
  const seenEmpty = new Set<string>();
  const requestIds = new Map<string, string>();
  let synthetic = false;
  const normalized: NetworkEntry[] = [];
  for (const entry of retained) {
    let bytes = Buffer.from(entry.payload, 'base64');
    if (!entry.frame) {
      synthetic = true;
      const key = `${connection(entry)}:${outbound(entry)}`;
      // A missing packet after normal traffic is not safely reconstructible.
      if (retained.some(other => other.index < entry.index && connection(other) === connection(entry) && outbound(other) === outbound(entry) && other.frame))
        throw Error(`Entry ${entry.index + 1}: redacted non-bootstrap traffic cannot be reconstructed.`);
      if (seenEmpty.has(key)) continue;
      seenEmpty.add(key);
      if (!uid) throw Error('Cannot reconstruct redacted authentication: no account ID remains in the log.');
      bytes = connection(entry) === connection(start)
        ? outbound(entry) ? frame(2000, login(username), true)
          : frame(2005, encode({ 1: 0, 2: uid, 3: { 1: uid, 3: username }, 8: TOKEN }), true)
        : frame(26200, gatewayPayload(encode({ 1: 1, 3: uid, 5: 32, 6: 6, 7: GATEWAY, 8: 0, 19: '11509231', 20: 4 }), encode(outbound(entry) ? { 1: TOKEN } : { 1: 0 })), true);
    } else if (entry.frame.command === 2000) {
      bytes = frame(2000, encode({ ...fieldsOf(decode(entry.frame.payload)), 3: SparkMD5.hash(PASSWORD), 7: MAC }), true);
    } else if (entry.frame.command === 2005) {
      const body = decode(entry.frame.payload);
      const fields = fieldsOf(body);
      if (body.bytes(8).length) fields[8] = TOKEN;
      bytes = frame(2005, encode(fields), true);
    } else if (entry.frame.command === 26200) {
      const [header, body] = unpack(entry.frame.payload);
      if (header.number(7) === GATEWAY && header.number(1) === 1 && outbound(entry))
        bytes = frame(26200, gatewayPayload(encode(fieldsOf(header)), encode({ ...fieldsOf(body), 1: TOKEN })), true);
      // This counter lives across logins in the original tab. Renumber it so
      // discarding earlier logins really makes their history irrelevant.
      if (header.number(7) === 20043 && header.number(1) === 1001) {
        const key = outbound(entry) ? 3 : 2, original = body.text(key);
        if (/^player-\d+$/.test(original) && !requestIds.has(original)) requestIds.set(original, `player-${requestIds.size + 1}`);
        const replacement = requestIds.get(original);
        if (replacement && replacement !== original) {
          const fields = fieldsOf(body);
          fields[key] = replacement;
          bytes = frame(26200, gatewayPayload(encode(fieldsOf(header)), encode(fields)), true);
        }
      }
    }
    normalized.push({ timestamp: entry.timestamp, source: entry.source, destination: entry.destination, payload: bytes.toString('base64') });
  }
  let previous = -Infinity;
  for (const entry of normalized) {
    const time = Date.parse(entry.timestamp);
    if (time < previous) throw Error('Retained log timestamps must be in chronological order.');
    previous = time;
  }
  return { entries: normalized, username, discarded: start.index, synthetic };
}

export function packets(entries: NetworkEntry[]): Packet[] {
  return entries.map((entry, index) => {
    const decoded = decodeOne(Buffer.from(entry.payload, 'base64'));
    if (!decoded || decoded[1] !== Buffer.from(entry.payload, 'base64').length) throw Error(`Expected one complete frame at entry ${index + 1}.`);
    return { ...entry, index, frame: decoded[0], outbound: outbound(entry), connection: connection(entry) };
  });
}

export type Action = { type: 'login' | 'match' | 'cancel' | 'play' | 'pass' | 'count' | 'confirm' | 'resign'; x?: number; y?: number; id?: number; accept?: boolean };
export function inferAction(packet: Frame): Action | null {
  if (packet.command === 2000) return { type: 'login' };
  if (packet.command !== 26200) return null;
  const [header, body] = unpack(packet.payload), service = header.number(7), op = header.number(1);
  if (service === ROOM && op === 100130) return { type: 'match', id: body.number(1) };
  if (service === ROOM && op === 100139) return { type: 'cancel' };
  if (service !== GAME) return null;
  if (op === 201) return { type: 'play', x: body.number(1), y: body.number(2) };
  if (op === 204) return { type: 'pass' };
  if (op === 301) return { type: 'count' };
  if (op === 304) return { type: 'confirm', accept: !!body.number(1) };
  if (op === 311) return { type: 'resign' };
  return null;
}
