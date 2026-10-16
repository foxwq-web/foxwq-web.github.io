# Client implementation notes

This analysis targets the 15,968,864-byte PE32 executable with SHA-256 `beb4112eb519985c5d0a8af5c342a0152ff1fa82e523c16428981a803b29994d`. All addresses below refer to this exact build. Names such as `send_gateway` are descriptive aliases, not recovered symbols.

The function addresses below are historical research references. Raw pseudocode, assembly, message indexes, and serializer-expression evidence are excluded from Git; they are not required to run the client. See the [local research prerequisites](../README.md#optional-local-reverse-engineering).

## Transport

The encoder is `0075a8d0`, the decoder is `0075a570`. A normal packet is:

```text
u16 big-endian N
u16 big-endian command
u8 flags
payload[N - 7]
u32 big-endian Adler-32(command || flags || transmitted payload)
```

`N` excludes the length prefix and includes the command, flags, and checksum. If `N >= 0x7fff`, the prefix becomes `u16(0x7fff), u16(11), u32(N)`, all big-endian. Flag `0` means uncompressed; flag `2` means zlib compression. The encoder uses level 9, retaining compression only if it reduces the payload size. The checksum covers the compressed bytes when compression is used. The reference decoder allocates a 10 MiB decompression buffer.

The checksum constructor passes type `0`. POCO defines this as Adler-32 in its [Checksum header](https://github.com/pocoproject/poco/blob/main/Foundation/include/Poco/Checksum.h). The compression entry points are `00d19160` and `00d190d0`. A readable, offline codec is in [framing.js](../src/framing.js).

There are two logical protocols inside this transport:

* Classic requests use the command directly, with a protobuf body. `00737620` performs serialization and queues the packet.
* New-framework requests use outer command `0x6658` (26200). Their payload is `u16 BE header_length || serialized Common.FGWHead || serialized message`. See `00745570`, `0075a840`, and `007376c0`.

Gateway request construction is `00745250`, with header initialization at `007456b0`. The actual calling convention passes the protobuf message in ECX, then sender object, service, node, and operation on the stack. Ghidra's inferred signature obscures this distinction.

Confirmed `Common.FGWHead` fields:

| Field | Wire kind | Request meaning |
| --- | --- | --- |
| 1 | uint32 | Operation ID |
| 3 | varint64 | Current user ID |
| 5 | uint32 | Constant `32` in this PC client |
| 6 | uint32 | Client/connection marker, initialized to `2` or `6` |
| 7 | uint32 | Destination service |
| 8 | uint32 | Destination node |
| 19 | bytes/string | Decimal build version `11509231` |
| 20 | int32 | Country/language selection mapped to `0..4` |

Other header fields are preserved in the recovered wire schema. Do not assume service/node IDs are interchangeable with room IDs.

## Login

The ordinary Fox password-login controller is `008711a0`, and its request builder is `0072edd0`. The latter sends classic command **2000**. Assembly for both was recorded in the local `analysis/instructions/` exports.

| `proto.LoginRequest` field | Wire kind | Ordinary password-login value |
| --- | --- | --- |
| 1 | bytes/string | UTF-8 account name |
| 2 | bytes/string | `foxwq` |
| 3 | bytes/string | Password representation; ordinary branch uses hexadecimal MD5 of UTF-8 input |
| 4 | int32 | `8` for ordinary password login; another branch uses `7` |
| 5 | int32 | Build/version constant `0xaf9def` |
| 6 | bool | Reconnect flag |
| 7 | bytes/string | Twelve uppercase MAC hex digits, without separators; required for successful live login |
| 8 | int32 | Not set by this builder |
| 9 | bool | Configuration-dependent flag |
| 10 | bytes/string | Not set by this builder |

The MD5 helper is `00552ff0`, and MAC formatting is reached through `00958e10` and `00958e90`. There is a separate credential-preprocessing branch; do not apply the ordinary MD5 transformation to an already transformed credential without examining that branch.

The login response serializer is `004eb940`, and the success/error handler is `008719c0`. Field 1 is the status (`0` is the success branch). Field 8 is copied into the session string at `DAT_01b82d2c`; this is confirmed by the local handler assembly. `00907380` retrieves it for gateway authentication.

Gateway login then uses `FGW.LoginRequest`, destination service **20001**, node **0**, operation **1**, built at `007396c0`. Field 1 carries that session string. The builder leaves field 2 unset and conditionally sets field 3 to `2`. Gateway heartbeat uses operation **5** at `007397d0`.

The binary contains server configuration keys `Server_Info`, `TGWLoginHost`, `TGWLoginPort`, `TGWHost`, and `TGWPort`. Their loader is `0065a6b0`. Bootstrap endpoint selection, transport negotiation, heartbeat intervals, and all login-response field meanings are not fully reconstructed here. The presence of `main_svr_adaptor.LoginRequest` does not establish that it replaces the ordinary PC login path.

## Normal matchmaking

The newer room manager is service **30006** (`0x7536`), node **0**. The field-selection dialog and request builders are the useful starting points, rather than the tournament `AMApplyOrCancelMatch` messages.

| Action | Operation | Builder/controller |
| --- | --- | --- |
| Login to room manager | 100008 | `00805960` |
| Room-manager heartbeat | 100010 | `0073b1a0` |
| Request all field information | 100145 | `00817310` |
| Request field configuration | 100150 | `008173b0` |
| Start matchmaking | 100130 | `0073b260`, `00817520` |
| Cancel player invitation | 100134 | `0073b520`, `008177d0` |
| Cancel matchmaking | 100139 | `0073b330` |
| Submit negotiated game rule | 100147 | `0073b7d0` |

`proto.room.AutoInviteRequest` has fields `1:int32`, `2:bool`, `3:int32`, `4:bytes`. The PC builder sets only field 1 (selected field ID) and field 2 (mode flag). It does **not** transmit a complete time-control rule in this initial request. The initial dialog path passes `false` for field 2; the exact interpretation of this flag needs confirmation before assigning it a UI label.

The dialog button handler is `0079f5d0`. It selects a list item's field data, then invokes `0079f060`. The field list is populated by `0079f240`, filtering entries by the user's rank. The main matching flow is `0079e480`.

For a minimal client, obtain `FetchAllFieldInfoResponse` and `FetchFieldCfgResponse`, decode their nested `FieldInfo`/`FieldCfg` records, select the ordinary field, then submit its ID. Handle `AutoInvitePlayerConfirmNotify`, `AutoInviteMakeRuleNotify`, and `EnterRoomNotify` as the server responds. These layouts, along with `GameRule`, are represented in the included observational schema.

Live `FetchFieldCfgResponse` identified **field 101** as the requested ordinary **19×19, 1200 seconds, 3 periods, 60 seconds** field: `FieldCfg` fields **2, 3, 4, 5**, respectively. The prototype matches these settings dynamically instead of relying on ID 101. `AutoInvitePlayerAnswerRequest` is operation **100136**, not 100134; it was not used in the verified fixed-setting normal match.

The classic automatch path is also retained: `0074a070` sends command **5040** (`0x13b0`) with `proto.AutoInviteRequest`; `008dc480` is its caller. This request contains only one varint64 field. The additional `GameMateRequest` family is present in the binary, but its presence alone does not identify the active normal-match flow.

## Playing a game

The newer game service is **31000**. Its node is read from the room's server identity, rather than set to zero for every request.

| Action | Operation | Builder |
| --- | --- | --- |
| Game heartbeat | 200 | `0073bc30` |
| Play a stone | 201 | `0073bdb0` |
| Pass | 204 | `0073bec0` |
| Request scoring | 301 | `0073c400` |
| Answer scoring request | 304 | `0073c4c0` |
| Request AI judging | 308 | `0073c650` |
| Resign | 311 | `0073c120` |
| Fetch/synchronize game environment | 501 | `0073bb20` |

`proto.game.SetPieceRequest` contains:

| Field | Meaning established by the PC builder |
| --- | --- |
| 1, 2 | Two integer board coordinates |
| 3 | Stone colour, accepted values `1` or `2` |
| 4 | Embedded `CheckSyn`; its field 1 is a per-game synchronization integer |
| 5 | Optional bytes, omitted by this builder |
| 6, 7 | Optional embedded messages, omitted by this builder |

`0080e950` checks that both coordinates are in `0..18`, and that colour is `1` or `2`. The `assembly` and `request-builder assembly` show the actual arguments. Live moves confirmed zero-based x/y coordinates and colours 1=black, 2=white. Copy synchronization from `SetPieceNotify.field5.CheckSyn.field1`, pass notification field 2, or game-environment response field 5. It is server state, not a locally invented counter.

The relevant inbound types are `RoomCreateNotify`, `StartSetPieceNotify`, `SetPieceResponse`, `SetPieceNotify`, `SkipSetPieceNotify`, `GameCountdownNotify`, `FetchGameEnvResponse`, `GameJudgingStateNotify`, `SetGameEndNotify`, and `SetGameResultNotify`. Their parser and serializer references were recorded in the excluded local message index. Keep the server's board, clock, and result state authoritative. The response/notification operation-ID dispatch table is not completely mapped in these notes.

The classic move builder `007458e0` sends command **7000**. It packs coordinates and an additional six-bit value as `((value & 0x3f) << 10) | ((coord2 & 0x1f) << 5) | (coord1 & 0x1f)`. Its `SetPieceRequest` layout is one varint64 followed by four int32 fields. Keep this distinct from the newer coordinate-per-field request.

## How to use the recovered schema

[recovered.proto](../protocol/recovered.proto) is an observational wire schema, not the original `.proto` source. Message class names come from RTTI/type-name strings; field numbers and encoding kinds come from virtual slot 9 serializers. Original field names, required/optional labels, enum names, and most nested types are not recoverable from those serializers alone.

Accordingly, fields have neutral names, original requiredness is represented as `optional`, and embedded messages/strings use `bytes`. A `uint64` field records varint64 encoding; original signedness may differ. `fixed32` preserves raw bits and may represent an original float. Supporting serializer expressions were recorded in the excluded local `protocol/wire-fields.json`; they are not included with the schema. Parse embedded bytes again with the appropriate message when its type is established.

Virtual slots used in the exports: 1 = type name, 2 = factory, 3 = clear, 6 = merge, 7 = protobuf parser, 8 = byte size, 9 = serializer. In particular, slot 6 is **not** the serializer.

Login, ordinary-field selection, moves, passing, environment restoration, and resignation were subsequently verified with a live Fox session. See [runtime protocol findings](runtime-protocol.md) and [prototype validation](prototype.md) for the confirmed mappings and remaining limits.
