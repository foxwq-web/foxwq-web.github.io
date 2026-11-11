# Network replay integration tests

These tests load the **production build** in headless Chromium. Test-only
WebSocket and heartbeat timer boundaries reproduce browser scheduling from the
recording. The WebSocket implementation feeds recorded server frames into the
normal client transport and captures every client send. Inferred actions use DOM inputs,
buttons, and board clicks. The runner never reads or changes Controller,
Session, board, or React state. No Fox server or running proxy is needed, and
remote network requests cannot escape the harness.

## Add a recording

Download a network log from the app, then run from the repository root:

```sh
npm run test:browser:install # Once, if Chromium is not installed
npm run test:integration -- --import /path/to/fox-network-log.json --name my-game
```

Import creates `fixtures/my-game.network.json`, automatically discarding
everything before the last login sequence and traffic belonging to older
connections. It normalizes authentication and request IDs as described below.
The original download is left untouched. Existing fixture names cannot be
overwritten by import.

If replay succeeds, the first run creates `fixtures/my-game.golden.json`.
Review both files and commit them. The first six checked-in fixtures were
imported from app exports on 2026-10-26:

| Recording | Retained session | Packets |
| --- | --- | ---: |
| `fox-network-log-20261019T2053` | Rejoin an existing game in overtime | 79 |
| `fox-network-log-20261020T0347` | Rejoin, opponent disconnect and reconnect | 410 |
| `fox-network-log-20261020T0404` | Rejoin, passing, counting rejection and resumption | 679 |
| `fox-network-log-20261020T0851` | Login and lobby discovery | 32 |
| `fox-network-log-20261021T2028` | Two matches, moves, resignation | 378 |
| `fox-network-log-20261024T0705` | Match retries, 76 moves, opponent resignation | 4469 |
| `fox-network-log-20261103T2114-spectator-takeback` | Ke Jie broadcast: historical takeback, 252 moves, W+R, review/download available | 39 |
| `fox-network-log-20261103T2139-unsupported-variant` | Direct route to an 11×11 Fly Cutter room; non-standard rules error stays in the room until Quit Room | 39 |
| `fox-network-log-20261103T2155-name-lookup` | Name lookup returns `payments 2d Offline` when the reply echoes `dst_uid = 0` | 36 |
| `fox-network-log-20261104T1914-spectator-handicap` | Six-stone handicap room: 171 moves replay, 170 stones remain, zero komi | 40 |
| `fox-network-log-20261104T1951-spectator-three-handicap` | Three-stone handicap room: 137 moves replay, 137 stones remain, W+R | 41 |

The November 4 three-stone extract retains the exact ENTER response completed at
export entry 5463 for room `20010:1:45842:1793785675`. It reuses the handicap
fixture's normalized login/directory bootstrap with shifted timestamps and a
reconstructed direct-route locate exchange for broadcast server 3. Unrelated
traffic and the automatic leave caused by the replay failure are omitted.
The regression check requires the populated final board, both players, W+R,
and enabled review/download controls. The second move occupies the lower-right
star point, which must be free in Fox's three-stone handicap setup.

The November 4 handicap extract retains the exact ENTER response from export
entry 7002 for room `20010:1:45857:1793815782`. It reuses the normalized login
and directory bootstrap from the November 3 unsupported-variant fixture, with
shifted timestamps, and reconstructs a direct-route locate exchange for broadcast
server 3. This focused composition omits unrelated traffic, retries, and the
automatic leave caused by the original replay failure. Provenance records the
source export and ENTER frame hashes. Its golden requires the populated board,
both players, correct captures, and no Spectating status text.

The November 3 extracts were located through conversation trace
`01a1a338-3cc2-7473-bb18-1dfd49bc64ce` and added on November 4. Each keeps
the export's initial login/directory bootstrap for the selected session and
one relevant request/response, omitting unrelated visits, traffic and retries.
The takeback extract also retains the latest directory refresh before entry:
the broadcast server changed after login. The unsupported room is hidden from
the directory, so its direct-route locate exchange is reconstructed from the
recorded room key and broadcast server. Its actual ENTER reply is preserved.
The extract ends after the clean broadcast LEAVE, with the error still displayed
in the room. The former automatic lobby subscription and list refresh are omitted;
returning to the lobby now requires Quit Room.
Provenance includes export hashes, zero-based source entry indexes, and hashes
of all retained server entries after normalization. The original exports in
Downloads are untouched. These are focused compositions, not uninterrupted
recordings. The goldens capture their regression outcomes, so review a regen
diff for an unexpectedly empty board or missing lookup result.

The October 30 recording ends with the server logout that previously cleared
the finished game. Its golden retains the board, `Game over: W+T`, enabled
review navigation and SGF download after that logout.
Controller tests additionally exercise offline variations and a pending estimate.

The October 24 evening recording was removed after measuring overlapping
production-code coverage. The retained recordings preserve the lobby, void game,
and resignation goldens, with older recordings adding overtime, game resumption,
opponent reconnection, passing, and counting. Background-tab throttling is no
longer a dedicated fixture scenario.

`fixtures/provenance.json` records original export hashes, discarded entry counts,
and changes in client packet counts. These recordings predate the current client:
after importing, `--update --update-messages` regenerated outgoing traffic and
strictly reverified it. This added player-info prefetches and removed player-info
requests no longer emitted by the current UI. Server entries are identical to
the normalized originals, including their timestamps and ordering. The
original downloads are untouched and are not needed to run the checked-in tests.
Outgoing player-list subscriptions, heartbeats, and unsubscriptions were also
updated to use lobby 1 after a live check confirmed lobby 0 returns empty pages.
Recorded server traffic remains unchanged.
Room-list requests now use category 0 (all rooms), replacing category 2 (quiz
rooms only). Lobby goldens include the Type, Online, and State columns.
Gateway authentication now starts room/player loading and profile prefetches
alongside room-manager discovery. Outgoing traffic in the three rejoin fixtures
and the November 3 extracts was regenerated for that ordering; server packets
and timestamps are unchanged. The remaining four recordings still need repair
for existing initial-lobby completion and heartbeat replay failures, so their
traffic and goldens were left unchanged.
Authentication reconstruction and request-ID normalization still apply as below.
The counting recording exercises rejecting an opponent request, resuming after a
nonzero rejection response, requesting counting, and continuing after the opponent
rejects it. Counting-result acceptance still lacks a real recording.

```sh
npm run test:integration                    # All fixtures, sorted by filename
npm run test:integration -- client/tests/integration/fixtures/my-game.network.json
npm run test:integration -- /path/to/log.json # Also works without importing
```

A directly supplied log is truncated and normalized in memory. Its first golden
is written beside it (`log.golden.json`); the input is only rewritten when
`--update-messages` is explicitly requested.

## Check and update artifacts

Subsequent runs require byte-identical client frames on the same connection
and an identical final UI golden. The golden contains the accessibility tree,
visible control text/values/enabled states, stone positions/colors, and board
annotations. It does not contain internal application state or pixel
screenshots; existing visual tests cover appearance.

```sh
npm run test:integration:update             # Accept intentional UI changes
npm run test:integration:update -- --update-messages
# Update just one recording:
npm run test:integration:update -- client/tests/integration/fixtures/my-game.network.json --update-messages
```

`--update` alone still checks outgoing traffic. `--update-messages` requires
`--update` and records the client's actual outgoing bytes, including added or
removed automatic requests. It leaves normalized server frames intact. Before
writing either artifact, it replays the proposed transcript again in strict
mode and checks that it produces the same UI. Changes incompatible with the
recorded server responses require a new recording.

Normal comparisons never replace a golden or a recording. A UI mismatch saves
`my-game.actual.json` beside the golden for `diff -u`; actual files are ignored
by Git. Packet mismatches report the entry, timestamp, connection, protocol
operation, first differing byte, and expected/actual base64. Unknown or
unproducible actions fail instead of injecting an expected client packet.

CI runs `npm run test:integration -- --ci`. Missing goldens fail in CI, and
updates/imports are refused. Setting the `CI` environment variable also enables
this behavior. `npm test` runs this fixture suite once per checked-in recording.

## What the log can reconstruct

Input is the app's JSON array of `{timestamp, source, destination, payload}`
entries, with base64 wire bytes and `client:…` connection identifiers. Fragmented
frames are assembled per connection/direction, coalesced frames are separated,
and completed messages retain chronological order. Timestamps after the last
login must be monotonic. The runner uses a paused virtual clock, advances it
through the recording, and uses recorded heartbeat ticks for outgoing timing
fields. After gateway login it captures the production heartbeat timer callback
and dispatches that callback at each recorded heartbeat send. Subsequent heartbeat
timers are held until the next recorded send, reproducing timer throttling in a
background tab without generating unrecorded heartbeats or spurious disconnects.
This checks heartbeat bytes and side effects, not the browser's timer cadence.
Other timers keep running normally. Long recordings run without waiting for real
elapsed game time. Outgoing packets may remain queued across unrelated incoming
traffic, but strict replay still compares every send in recorded outbound order.

The importer makes two explicit changes beyond truncation/deframing:

* **Authentication:** exports erase login requests, login responses, and gateway
  authentication. Test fixtures use the password `network-replay`, a zero MAC,
  and the token `offline-replay-token`. Unredacted authentication retains its
  other protocol/profile fields. For erased bootstrap packets, a minimal
  successful login is reconstructed from the UID in discovery/gateway traffic;
  the unavailable account name is `Replay player`. Lost account/rank data is
  not claimed to be recovered. A recording without enough discovery traffic
  fails with an explanation. Redacted non-bootstrap traffic cannot be repaired.
* **Player-info request IDs:** `player-N` profile requests and `lookup-N` name
  searches share a counter in the original tab. IDs and corresponding responses
  are renumbered together from the first retained request/response, so omitted
  requests and older logins are irrelevant.

Every outgoing frame in the resulting canonical fixture, including synthetic
authentication, is subsequently checked byte for byte. Normalization preserves
non-secret authentication protocol fields so client-version changes still fail.
Import does not anonymize account names or game data elsewhere in the recording.

Supported inferred actions are login, selecting the time control and matching,
stone placement, passing, requesting counting, accepting/rejecting counting,
resigning, spectator navigation, and name searches. Listed rooms use their
links; absent rooms use browser route navigation. A recorded name request
implies typing its exact name 300 ms before the send, allowing the production
debounce to run without shifting later packet timestamps.
A new match after a finished game implies leaving
that room first. A resignation packet is replayed through Resign; the same
packet can also have originated from Quit Room during play, so that intent
cannot be distinguished. There is currently no production control for the
protocol's matchmaking-cancel request; such a recording fails explicitly.

Local-only actions (review/variation navigation, score estimation, downloads,
hovering an already cached player, fullscreen, and leaving a finished room
without a following match) are absent from the log and cannot be inferred.
Connection open/close events and HTTP responses are also absent. Connections
are matched by their recorded destinations and opening order; missing lifecycle
events cannot be invented. Player-history HTTP requests receive an empty,
successful offline response. The goldens describe the reproducible UI under
these conventions, rather than all unrecorded user interactions.

## Extending the harness

`log.ts` owns validation, truncation, normalization, and protocol-to-action
inference. `browser.ts` contains the WebSocket boundary, DOM drivers, and UI
snapshot. `replay.ts` owns clock advancement, packet comparison, and proposed
traffic updates. `artifacts.ts` handles golden recording/comparison. Add a DOM
driver and an inference rule when a new production action becomes observable
on the wire. Unit tests cover log handling and the golden-artifact lifecycle;
the fixture replays exercise packet differences, added/removed automatic
messages, and repeatability.

The lobby update adds native player subscriptions and active-game list requests.
Subscriptions pause while a board is open. Updated recordings retain the server
frames and infer returning to the lobby from its outgoing subscription when
that local action precedes the next match.

Historical recordings that predate the PC directory include explicitly synthetic
empty PC bootstrap traffic. Three older recordings also include synthetic empty
broadcast room/player list replies so the current lobby can finish loading.
`provenance.json` lists those replies separately and records both the complete
fixture hash and the original server-traffic hash. The replay unit checks verify
the original bytes, order and timestamps after excluding only those documented
additions. Client traffic and UI goldens are regenerated through the production
replay and verified again in strict mode.
