import { Buffer } from "buffer";

export function varint(input: number | bigint) {
  let value = BigInt.asUintN(64, BigInt(input));
  const out = [];
  while (value > 127n) {
    out.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  out.push(Number(value));
  return Buffer.from(out);
}
export function readVarint(
  data: Uint8Array,
  offset = 0,
): [number | bigint, number] {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (offset >= data.length) throw Error("truncated varint");
    const b = data[offset++];
    if (shift === 63n && b > 1) throw Error("overflowing varint");
    value |= BigInt(b & 127) << shift;
    if (b < 128)
      return [
        value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value,
        offset,
      ];
  }
  throw Error("overflowing varint");
}
export type FieldValue =
  number | bigint | boolean | string | Uint8Array | Fields;
export interface Fields {
  [key: number]: FieldValue | FieldValue[] | null | undefined;
}
export type WireValue = number | bigint | Buffer;
export function encode(fields: Fields = {}) {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    const number = Number(key);
    if (!Number.isInteger(number) || number <= 0 || number >= 2 ** 29)
      throw Error("invalid protobuf field");
    for (let item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") item = Buffer.from(item);
      if (typeof item === "object" && !ArrayBuffer.isView(item))
        item = encode(item);
      if (ArrayBuffer.isView(item))
        parts.push(
          varint(number * 8 + 2),
          varint(item.byteLength),
          Buffer.from(item as Uint8Array),
        );
      else
        parts.push(
          varint(number * 8),
          varint(typeof item === "boolean" ? Number(item) : item),
        );
    }
  }
  return Buffer.concat(parts);
}
export class Message extends Map<number, WireValue[]> {
  one(field: number, fallback: WireValue = 0) {
    return this.get(field)?.at(-1) ?? fallback;
  }
  number(field: number, fallback = 0): number {
    const value = this.one(field, fallback);

    if (typeof value === "bigint") return Number.NaN;
    if (typeof value !== "number")
      throw Error("Expected numeric protobuf field");
    return value;
  }
  bytes(field: number): Buffer {
    const value = this.one(field, Buffer.alloc(0));
    if (!Buffer.isBuffer(value)) throw Error("Expected protobuf bytes");
    return value;
  }
  sub(field: number) {
    return decode(this.one(field, Buffer.alloc(0)));
  }
  text(field: number, fallback = "") {
    const value = this.one(field, Buffer.from(fallback));
    if (!Buffer.isBuffer(value)) throw Error("Expected protobuf bytes");
    return value.toString("utf8");
  }
}
export function decode(input: WireValue | Uint8Array) {
  if (!(input instanceof Uint8Array)) throw Error("Expected protobuf bytes");
  const data = Buffer.from(input);
  const out = new Message();
  let offset = 0;
  while (offset < data.length) {
    let tag, value;
    [tag, offset] = readVarint(data, offset);
    if (typeof tag !== "number") throw Error("invalid protobuf tag");
    const number = Math.floor(tag / 8),
      wire = tag % 8;
    if (!number || number >= 2 ** 29) throw Error("invalid protobuf tag");
    if (wire === 0) [value, offset] = readVarint(data, offset);
    else if (wire === 2) {
      let length;
      [length, offset] = readVarint(data, offset);
      if (typeof length !== "number" || length > data.length - offset)
        throw Error("truncated protobuf bytes");
      value = Buffer.from(data.subarray(offset, offset + length));
      offset += length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > data.length) throw Error("truncated fixed field");
      value =
        size === 8 ? data.readBigUInt64LE(offset) : data.readUInt32LE(offset);
      if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER))
        value = Number(value);
      offset += size;
    } else throw Error(`unsupported protobuf wire type ${wire}`);
    if (!out.has(number)) out.set(number, []);
    out.get(number)!.push(value);
  }
  return out;
}
export function signed(value: WireValue) {
  if (Buffer.isBuffer(value)) throw Error("Expected numeric protobuf field");
  return Number(BigInt.asIntN(32, BigInt(value)));
}
