"""Small protobuf wire codec; preserves unknown fields without a runtime dependency."""
import struct


def varint(value):
    value &= (1 << 64) - 1
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def read_varint(data, offset=0):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError('truncated varint')
        b = data[offset]
        offset += 1
        if shift == 63 and b > 1:
            raise ValueError('overflowing varint')
        value |= (b & 127) << shift
        if b < 128:
            return value, offset
    raise ValueError('overflowing varint')


def encode(fields):
    out = bytearray()
    for number, value in fields.items():
        if value is None:
            continue
        if not 0 < number < 1 << 29:
            raise ValueError('invalid protobuf field')
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str):
                item = item.encode('utf-8')
            if isinstance(item, dict):
                item = encode(item)
            if isinstance(item, bytes):
                out += varint(number << 3 | 2) + varint(len(item)) + item
            else:
                out += varint(number << 3) + varint(int(item))
    return bytes(out)


class Message(dict):
    def one(self, field, default=0):
        return self.get(field, [default])[-1]

    def sub(self, field):
        return decode(self.one(field, b''))

    def text(self, field, default=''):
        value = self.one(field, default.encode())
        return value.decode('utf-8', errors='replace')


def decode(data):
    out = Message()
    offset = 0
    while offset < len(data):
        tag, offset = read_varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0 or number >= 1 << 29:
            raise ValueError('invalid protobuf tag')
        if wire == 0:
            value, offset = read_varint(data, offset)
        elif wire == 2:
            length, offset = read_varint(data, offset)
            if length > len(data) - offset:
                raise ValueError('truncated protobuf bytes')
            value = bytes(data[offset:offset+length])
            offset += length
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            if offset + size > len(data):
                raise ValueError('truncated fixed field')
            value = struct.unpack_from('<Q' if size == 8 else '<I', data, offset)[0]
            offset += size
        else:
            raise ValueError(f'unsupported protobuf wire type {wire}')
        out.setdefault(number, []).append(value)
    return out


def signed(value):
    value &= 0xffffffff
    return value - (1 << 32) if value >= 1 << 31 else value
