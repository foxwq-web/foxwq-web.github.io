import { TAG_BIG_MESSAGE, TAG_MTID_CS_BIGPROTOCOL_MSG } from "./protocol.ts";
import { Buffer } from "buffer";
import { zlibSync, Unzlib } from "fflate";
// Web resource limit; independent of Android NetMsg.MAX_BUFF_SIZE.
export const MAX_SIZE = 10 * 1024 * 1024;
const ADLER32_MODULUS = 65521;
const NET_MSG_FLAG_RAW = 0;
const NET_MSG_FLAG_ZLIB = 2;
const NET_MSG_BODY_OVERHEAD = 7; // msgTypeID (2), flag (1), checksum (4).
export interface NetMsg {
  msgTypeID: number;
  flag: number;
  rawProto: Buffer;
}
export function adler32(data: Uint8Array) {
  let a = 1,
    b = 0;
  for (const byte of data) {
    a = (a + byte) % ADLER32_MODULUS;
    b = (b + a) % ADLER32_MODULUS;
  }
  return ((b << 16) | a) >>> 0;
}
export function netMsgToBytes(msgTypeID: number, input: Uint8Array, compress = false) {
  let rawProto: Buffer = Buffer.from(input);
  let flag = NET_MSG_FLAG_RAW;
  if (compress && rawProto.length) {
    const packed = Buffer.from(zlibSync(rawProto, { level: 9 }));
    if (packed.length < rawProto.length) {
      rawProto = packed;
      flag = NET_MSG_FLAG_ZLIB;
    }
  }
  const length = rawProto.length + NET_MSG_BODY_OVERHEAD;
  if (length > MAX_SIZE) throw Error("invalid frame length");
  const prefix = Buffer.alloc(length < TAG_BIG_MESSAGE ? 2 : 8);
  if (prefix.length === 2) prefix.writeUInt16BE(length);
  else {
    prefix.writeUInt16BE(TAG_BIG_MESSAGE);
    prefix.writeUInt16BE(TAG_MTID_CS_BIGPROTOCOL_MSG, 2);
    prefix.writeUInt32BE(length, 4);
  }
  const body = Buffer.alloc(length);
  body.writeUInt16BE(msgTypeID);
  body[2] = flag;
  rawProto.copy(body, 3);
  body.writeUInt32BE(adler32(body.subarray(0, -4)), length - 4);
  return Buffer.concat([prefix, body]);
}
export function extractNetMsgFromBytes(
  data: Buffer,
  maxSize = MAX_SIZE,
): [NetMsg, number] | null {
  if (data.length < 2) return null;
  let length = data.readUInt16BE(0),
    prefix = 2;
  if (length === TAG_BIG_MESSAGE) {
    if (data.length < 8) return null;
    length = data.readUInt32BE(4);
    prefix = 8;
  } else if (length >= 0x8000) throw Error("negative short frame length");
  if (length < NET_MSG_BODY_OVERHEAD || length > maxSize) throw Error("invalid frame length");
  if (data.length < prefix + length) return null;
  const body = data.subarray(prefix, prefix + length);
  if (adler32(body.subarray(0, -4)) !== body.readUInt32BE(length - 4))
    throw Error("Adler-32 mismatch");
  const flag = body[2];
  let rawProto: Buffer = Buffer.from(body.subarray(3, -4));
  if (flag === NET_MSG_FLAG_ZLIB) {
    const chunks: Buffer[] = [];
    let size = 0,
      complete = false;
    const inflater = new Unzlib((chunk, final) => {
      size += chunk.length;
      if (size > maxSize) throw Error("oversized compressed payload");
      chunks.push(Buffer.from(chunk));
      complete = final;
    });

    for (let offset = 0; offset < rawProto.length; offset += 256)
      inflater.push(
        rawProto.subarray(offset, offset + 256),
        offset + 256 >= rawProto.length,
      );
    if (!complete || rawProto.length < 6)
      throw Error("invalid compressed payload");
    const unpacked = Buffer.concat(chunks);
    if (adler32(unpacked) !== rawProto.readUInt32BE(rawProto.length - 4))
      throw Error("compressed Adler-32 mismatch");
    rawProto = unpacked;
  } else if (flag !== NET_MSG_FLAG_RAW) throw Error(`unknown flags: ${flag}`);
  return [{ msgTypeID: body.readUInt16BE(0), flag, rawProto }, prefix + length];
}
export function encodeFgwPacket(header: Buffer, message: Buffer) {
  if (header.length > 65535) throw Error("gateway header too large");
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(header.length);
  return Buffer.concat([prefix, header, message]);
}
export function splitFgwPacket(payload: Buffer): [Buffer, Buffer] {
  if (payload.length < 2) throw Error("truncated gateway payload");
  const length = payload.readUInt16BE(0);
  if (payload.length < 2 + length) throw Error("truncated gateway header");
  return [payload.subarray(2, 2 + length), payload.subarray(2 + length)];
}
