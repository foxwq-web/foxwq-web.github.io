# Runtime protocol findings

These mappings combine decompiled request builders/handlers with live traffic from the prototype on 2026-10-06. The original diagnostic traffic was stored in ignored local `analysis/live/` files and is not included in Git. This document records protocol structure only; it is a historical account, not a new check of server behavior or availability.

## Login and discovery

The installed client's observed fallback **43.132.13.39:10000** accepts classic command **2000** and responds with **2005**. The ordinary request has the field values documented in `client-protocol.md`. MAC field 7 must be **12 uppercase hexadecimal digits without separators**: a hyphenated representation produced status −1 and no authenticated session; the matching representation succeeded.

Success gives user ID in response field 2 (also nested `UserInfo.field1`) and gateway token in field 8. Classic **3000** requests the server list, responding with **3005**; **3010** requests navigation metadata, responding with **3015**. Ignore empty/duplicate 3005 responses instead of erasing the discovered list.

Server-list field 3 contains repeated records. Record fields **21 (host)** and **22 (port)** identify the game gateway for the selected server. The navigation response's string fields are URLs, not gateway endpoints.

Gateway login: outer **26200**, FGW header service **20001**, node **0**, operation **1**; body field 1 is the session token. Successful response field 1 is zero. Then send service **30006**, node **0**, operation **100008**, body `{1:true}`. Its success response permits **100145** (field populations), **100150** (field configurations), and **100115** (query existing game).

The outgoing header uses fields `{1:operation,3:userID,5:32,6:6,7:service,8:node,19:"11509231",20:4}` for the ordinary English PC route. Do not decode an entire 26200 payload directly as protobuf: split the u16-length-prefixed header first.

## Normal matchmaking

`FetchFieldCfgResponse.field1` holds repeated `FieldCfg` messages. Select exactly one record where fields `{2:19,3:1200,4:3,5:60,7:0,12:1}` match normal Go and the requested time control. The returned field ID was **101** in the tested session. Operation **100130** uses `{1:fieldID,2:false}`; successful response field 1 is zero. **100139**, empty body, cancels matchmaking.

The tested fixed-setting field entered a game directly, without custom-rule negotiation. The general invitation-answer operation **100136** is distinct from invitation cancellation **100134**.

## Room identity and game start

`EnterRoomNotify` (**100140**) supplies:

| Field | Meaning |
| --- | --- |
| 1 | Status |
| 2 | Game service (31000) |
| 3 | Game server node |
| 4 | Room number |
| 7 | Room identity used in `RoomKey.field4` |

Join by sending game service **31000**, selected node, operation **105**, **empty body**. Fox then supplies game environment **501**. A **107 StartSetPieceNotify may arrive before 100140**: do not downgrade an already-started game back to a waiting state.

Start-notification field **1 is GameRule**, not RoomKey. Fields **3 and 7 are different identities**. Build RoomKey using game service, header node, start field **6** (room number), and start field **7** (room identity). Never substitute start field 3 into RoomKey.field4.

Start field **9** contains repeated `GameUserInfo`; user ID is field **1**, colour field **6** (1 black, 2 white). Field **4 is rank**, not colour. Clock values are main seconds **7**, period count **8**, byoyomi seconds **9**.

## Moves, pass, and results

| Operation | Direction | Body |
| --- | --- | --- |
| 201 | Request / acknowledgment | Request `{1:x,2:y,3:colour,4:{1:sync}}`; ack field 1 is status |
| 203 | Notification | x/y/colour fields 1/2/3, clock field 4, synchronization field 5 |
| 204 | Request / acknowledgment | Request `{1:{1:sync}}` |
| 206 | Pass notification | Clock field 1, synchronization field 2 |
| 301 | Request / acknowledgment | Original scoring builder sets `{1:0}` |
| 303 | Notification | Opponent scoring confirmation |
| 304 | Request / acknowledgment | `{1:accept,2:1}` for the ordinary confirmation route; a separate reference route uses mode 2 |
| 311 | Request / acknowledgment | `{1:colour,2:RoomKey}` |
| 402 | Notification | Game end |
| 403 | Notification | Detailed final result |

Coordinates are zero-based. The client updates the board from notifications, not acknowledgments. `CheckSyn.field1` comes from the latest server notification/environment. A move notification's nested clock contains fields **2 main seconds, 3 periods, 4 byoyomi seconds**.

End/result fields **2 winner, 3 result/margin, 4 reason** are passed to the reference result handler. The observed successful resignation produced `{2:2,3:-1,4:3}` → **W+R**. Reason 8 appeared for an abandoned initial-start game. Numeric scoring margin conversion is still being investigated; the prototype reports raw Fox result values instead of inventing a point conversion.

## Reconnection

Query **100115**. If its status field 1 is zero and service field 2 is 31000, send **501**, empty body, to node field 3. Fox can locate the game using the authenticated user.

Environment response fields:

| Field | Meaning |
| --- | --- |
| 1 | Status |
| 2 | GameRule |
| 3 | Repeated GameUserInfo |
| 4 | Repeated StoneMove |
| 5 | CheckSyn |
| 7 | Room number |
| 9 | Game identity (different from room identity) |
| 10 | Room identity for RoomKey.field4 |
| 12 | Service |
| 13 | Server node |

A `StoneMove` is `{1:type,2:x,3:y,4:colour}`: type 1 places a stone, type 2 passes. Replay these in order to rebuild captures, ko history, and the next turn. Resumption after seven recorded moves was verified live; further moves and resignation succeeded after reconnecting.

Gateway heartbeats use service 20001 operation 5; manager heartbeats use 30006/100010; game heartbeats use 31000/200 with field 3 RoomKey. The short-lived navigation connection may close after bootstrap while the game gateway remains usable; do not tear down the game for that closure.
