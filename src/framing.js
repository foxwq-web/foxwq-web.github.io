import { Buffer } from 'buffer';
import { zlibSync, Unzlib } from 'fflate';
export const MAX_SIZE = 10 * 1024 * 1024;
export function adler32(data) {
  let a = 1, b = 0;
  for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
export function encode(command, payload, compress = false) {
  payload = Buffer.from(payload);
  let flags = 0;
  if (compress && payload.length) {
    const packed = Buffer.from(zlibSync(payload, { level: 9 }));
    if (packed.length < payload.length) { payload = packed; flags = 2; }
  }
  const length = payload.length + 7;
  if (length > MAX_SIZE) throw Error('invalid frame length');
  const prefix = Buffer.alloc(length < 0x7fff ? 2 : 8);
  if (prefix.length === 2) prefix.writeUInt16BE(length);
  else { prefix.writeUInt16BE(0x7fff); prefix.writeUInt16BE(11, 2); prefix.writeUInt32BE(length, 4); }
  const body = Buffer.alloc(length);
  body.writeUInt16BE(command); body[2] = flags; payload.copy(body, 3);
  body.writeUInt32BE(adler32(body.subarray(0, -4)), length - 4);
  return Buffer.concat([prefix, body]);
}
export function decodeOne(data, maxSize = MAX_SIZE) {
  if (data.length < 2) return null;
  let length = data.readUInt16BE(0), prefix = 2;
  if (length === 0x7fff) {
    if (data.length < 8) return null;
    length = data.readUInt32BE(4); prefix = 8;
  } else if (length >= 0x8000) throw Error('negative short frame length');
  if (length < 7 || length > maxSize) throw Error('invalid frame length');
  if (data.length < prefix + length) return null;
  const body = data.subarray(prefix, prefix + length);
  if (adler32(body.subarray(0, -4)) !== body.readUInt32BE(length - 4)) throw Error('Adler-32 mismatch');
  const flags = body[2];
  let payload = Buffer.from(body.subarray(3, -4));
  if (flags === 2) {
    const chunks = []; let size = 0, complete = false;
    const inflater = new Unzlib((chunk, final) => {
      size += chunk.length;
      if (size > maxSize) throw Error('oversized compressed payload');
      chunks.push(Buffer.from(chunk)); complete = final;
    });
    // Feed small chunks to bound allocation before the output limit is checked.
    for (let offset = 0; offset < payload.length; offset += 256) inflater.push(payload.subarray(offset, offset + 256), offset + 256 >= payload.length);
    if (!complete || payload.length < 6) throw Error('invalid compressed payload');
    const unpacked = Buffer.concat(chunks);
    if (adler32(unpacked) !== payload.readUInt32BE(payload.length - 4)) throw Error('compressed Adler-32 mismatch');
    payload = unpacked;
  } else if (flags !== 0) throw Error(`unknown flags: ${flags}`);
  return [{ command: body.readUInt16BE(0), flags, payload }, prefix + length];
}
export function gatewayPayload(header, message) {
  if (header.length > 65535) throw Error('gateway header too large');
  const prefix = Buffer.alloc(2); prefix.writeUInt16BE(header.length);
  return Buffer.concat([prefix, header, message]);
}
export function splitGateway(payload) {
  if (payload.length < 2) throw Error('truncated gateway payload');
  const length = payload.readUInt16BE(0);
  if (payload.length < 2 + length) throw Error('truncated gateway header');
  return [payload.subarray(2, 2 + length), payload.subarray(2 + length)];
}
