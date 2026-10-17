"""Offline reconstruction of NetMessage (0075a570/0075a8d0).

Derived from static analysis and verified against live login and game traffic.
"""
from dataclasses import dataclass
import struct
import zlib


@dataclass(frozen=True)
class Frame:
    command: int
    flags: int
    payload: bytes


def encode(command: int, payload: bytes, compress: bool = False) -> bytes:
    flags = 0
    if compress and payload:
        packed = zlib.compress(payload, 9)
        if len(packed) < len(payload):
            payload, flags = packed, 2
    body = struct.pack('>HB', command, flags) + payload
    body += struct.pack('>I', zlib.adler32(body))
    length = len(body)
    prefix = struct.pack('>H', length) if length < 0x7fff else struct.pack('>HHI', 0x7fff, 11, length)
    return prefix + body


def decode_one(data: bytes, max_size: int = 10 * 1024 * 1024):
    """Return (Frame, bytes_consumed), or None when more TCP data is needed."""
    if len(data) < 2:
        return None
    length, = struct.unpack_from('>H', data)
    prefix = 2
    if length == 0x7fff:
        if len(data) < 8:
            return None
        length, = struct.unpack_from('>I', data, 4)
        prefix = 8
    elif length >= 0x8000:
        raise ValueError('negative short frame length')
    if not 7 <= length <= max_size:
        raise ValueError('invalid frame length')
    total = prefix + length
    if len(data) < total:
        return None
    body = data[prefix:total]
    checksum, = struct.unpack_from('>I', body, length-4)
    if zlib.adler32(body[:-4]) != checksum:
        raise ValueError('Adler-32 mismatch')
    command, flags = struct.unpack_from('>HB', body)
    payload = body[3:-4]
    if flags == 2:
        inflater = zlib.decompressobj()
        payload = inflater.decompress(payload, max_size + 1)
        if len(payload) > max_size or inflater.unconsumed_tail or not inflater.eof:
            raise ValueError('invalid or oversized compressed payload')
    elif flags != 0:
        raise ValueError(f'unknown flags: {flags}')
    return Frame(command, flags, payload), total


def gateway_payload(header: bytes, message: bytes) -> bytes:
    """00745570: u16 BE serialized FGWHead size, FGWHead, message body."""
    return struct.pack('>H', len(header)) + header + message


def split_gateway(payload: bytes):
    if len(payload) < 2:
        raise ValueError('truncated gateway payload')
    length, = struct.unpack_from('>H', payload)
    if len(payload) < 2 + length:
        raise ValueError('truncated gateway header')
    return payload[2:2+length], payload[2+length:]
