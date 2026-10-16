import { encode, decode } from './wire.js';
import { gatewayPayload, splitGateway } from './framing.js';
export const GATEWAY = 20001, ROOM = 30006, GAME = 31000;
export const NORMAL = [19, 1200, 3, 60];
export function envelope(uid, service, operation, fields = {}, node = 0) {
  return gatewayPayload(encode({ 1: operation, 3: uid, 5: 32, 6: 6, 7: service, 8: node, 19: '11509231', 20: 4 }), encode(fields));
}
export function unpack(payload) { return splitGateway(payload).map(decode); }
export function normalField(records) {
  const matches = records.filter(r => [2, 3, 4, 5].every((f, i) => r.one(f) === NORMAL[i]) && r.one(12) === 1 && r.one(7) === 0);
  if (matches.length !== 1) throw Error('Fox did not advertise one unambiguous normal 20 min / 3 × 60 s field');
  return matches[0].one(1);
}
export function plain(message) { return Object.fromEntries([...message].map(([key, values]) => [key, values.length > 1 ? values : values[0]])); }
