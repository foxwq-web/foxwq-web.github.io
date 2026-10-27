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
Review both files and commit them. The checked-in fixtures come from six actual
app exports in `/Users/olivier/Downloads/logs/`, imported on 2026-10-26:

| Recording | Retained session | Packets |
| --- | --- | ---: |
| `fox-network-log-20261019T2053` | Rejoin an existing game in overtime | 79 |
| `fox-network-log-20261020T0347` | Rejoin, opponent disconnect and reconnect | 410 |
| `fox-network-log-20261020T0404` | Rejoin, passing, counting rejection and resumption | 679 |
| `fox-network-log-20261020T0851` | Login and lobby discovery | 32 |
| `fox-network-log-20261021T2028` | Two matches, moves, resignation | 378 |
| `fox-network-log-20261024T0705` | Match retries, 76 moves, opponent resignation | 4469 |

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
this behavior. `npm test` includes the fixture suite and the harness's own
regression checks; run those separately with `npm run test:integration:harness`.

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
* **Player-info request IDs:** the `player-N` counter survives login in the
  original tab. IDs and corresponding responses are renumbered from the first
  retained request/response, so older logins are irrelevant.

Every outgoing frame in the resulting canonical fixture, including synthetic
authentication, is subsequently checked byte for byte. Normalization preserves
non-secret authentication protocol fields so client-version changes still fail.
Import does not anonymize account names or game data elsewhere in the recording.

Supported inferred actions are login, selecting the time control and matching,
stone placement, passing, requesting counting, accepting/rejecting counting,
and confirming resignation. A new match after a finished game implies leaving
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
on the wire. Unit tests cover log handling, and the browser harness tests
deliberate packet differences, added/removed automatic messages, repeatability,
and the golden lifecycle.
