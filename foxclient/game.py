"""Game messages recovered from the Windows request builders.

Field names reflect the builder/handler evidence; unknown fields stay opaque.
"""
from .wire import encode, decode
from protocol.framing import gateway_payload, split_gateway

GATEWAY = 20001
ROOM = 30006
GAME = 31000
NORMAL = (19, 1200, 3, 60)


def envelope(uid, service, operation, fields=None, node=0):
    header = encode({1:operation,3:uid,5:32,6:6,7:service,8:node,
                     19:'11509231',20:4})
    return gateway_payload(header, encode(fields or {}))


def unpack(payload):
    header, body = split_gateway(payload)
    return decode(header), decode(body)


def normal_field(records):
    matches = [r.one(1) for r in records
               if tuple(r.one(f) for f in (2,3,4,5)) == NORMAL
               and r.one(12) == 1 and r.one(7) == 0]
    if len(matches) != 1:
        raise ValueError('Fox did not advertise one unambiguous normal 20 min / 3 × 60 s field')
    return matches[0]


def plain(message):
    return {field: values if len(values)>1 else values[0]
            for field,values in message.items()}
