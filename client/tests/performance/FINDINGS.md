# DOM and JavaScript runtime investigation — 2026-10-30

The measured offline paths have a small DOM and bounded node/listener counts.
Three rendering costs were demonstrated and fixed in separate commits. This is
a production-mode Chromium investigation with synthetic offline inputs, plus the
existing recorded-network and visual suites; it does not establish live Fox
latency, phone performance, or the absence of every possible memory leak.

Environment: Node 26.11.0, Chromium 156.0.8078.4, macOS arm64, Apple M6.
Viewports: 1280×900 and 390×844 CSS pixels. The narrow run uses desktop Chromium,
without mobile CPU/network emulation. See [method and commands](README.md).
All reported work times below are medians of fresh-page samples, excluding
trailing animation frames. Accelerated `flushSync` events isolate scripting and
React work; they are not frame-rate or real-user latency measurements.

| Measured change | Desktop before → after | Narrow before → after | Deterministic evidence |
| --- | --- | --- | --- |
| Memoize matchmaking controls, 720 clock events, 5 samples | 59.6 → 56.9 ms | 59.2 → 57.1 ms | Hidden radio attribute writes: 6,480 → 0; total mutations: 6,840 → 360 |
| Memoize unchanged stones, 720 clock events, 5 samples, incremental | 56.9 → 42.2 ms | 57.1 → 41.5 ms | Stone renders: 27,360 → 0 |
| Same stone change, 720 pointer events, 5 samples, incremental | 63.4 → 50.5 ms | 63.2 → 50.3 ms | Stone renders: 27,016 → 644, confined to the moving preview |
| Memoize Black's history content, 200 clock events, 3 samples | 58.0 → 22.3 ms | 57.8 → 22.6 ms | History-content renders: 200 → 0; 10 rows remain |
| Same history change, White's card, 200 clock events, 3 samples | 59.4 → 21.0 ms | 57.4 → 20.8 ms | History-content renders: 200 → 0; 10 rows remain |
| Same history change, lobby card, 200 synthetic clock events, 3 samples | 56.7 → 17.5 ms | 56.4 → 20.7 ms | History-content renders: 200 → 0; lobby does not normally schedule clock ticks |
| Same history change, 200 cached card open/close pairs, 3 samples | 157.0 → 123.5 ms | 155.5 → 123.0 ms | History-content renders: 400 → 200; duplicate popup-position renders disappear |

Session snapshots are structured clones. Server updates therefore replace the
props used by these memoized components, allowing new populations, selections,
positions, summaries and histories to render. Clock and pointer state updates
reuse the session snapshot. The history component's download/error state still
updates independently. Existing interaction and visual tests verify those
behaviors; no caching of mutable store objects was added.

Raw evidence is retained in [results/](results/). `before.json` is the original
application, `time-controls.json` adds the control optimization, and `stones.json`
adds the stone optimization. `survey-before-history.json` contains both of those
changes; `survey.json` additionally contains the history optimization. Each survey
has 158 samples, including 70 screen/viewport combinations. `estimator-soak.json`
and `estimator-heap.json` investigate memory separately from timed samples.
Board-position checksums, DOM counts, history row counts and annotations match
across the history comparisons. Original clock/pointer final DOM values also
match across all five samples per viewport and revision.

| Area | Exercised coverage and observations |
| --- | --- |
| Every offline screen | All 35 `DEV_SCREENS` fixtures at both widths: login and connection stages/errors, restoration, matchmaking/search/join/room exit, both colors, opponent turn/pass, both passed, byoyomi, rejected moves, all counting states, estimation/loading, variation, and all result types. Expected session phases and required overlays/cards are asserted. |
| DOM and idle work | Across the 70 settled screens: 156–429 elements; root depth at most 11; no horizontal overflow or script errors. Each 200 ms stopped-clock idle window had zero node/listener growth and zero layouts. Separate two-second idle checks also had zero component renders or DOM mutations. |
| Board and clocks | 720 clock/pointer events, five samples per width; coordinates, both turns, legality, captures, ko, suicide and placement have browser checks. Eight additional 720-pointer blocks held node/listener counts at 312/204. Post-GC heap changes are retained in the reports rather than interpreted as leak proof. |
| Player summaries and history | Three player-card fixtures with their actual store/request paths and 10 sample games. Three samples of 200 cached open/close pairs per width, and 200 clock events with each card visible. Repeated card interactions returned to the same DOM/node/listener counts. Existing browser checks also cover pointer, keyboard, touch, viewport placement and history SGF download. |
| Replay and variations | Three samples of 200 Previous/Next actions per width, plus a five-move variation. Each reversible sequence retained the same board checksum, node/listener counts and variation numbers. Final median work: replay 51.9/52.0 ms, variation 56.7/54.6 ms (desktop/narrow). Recorded-game timing and SGF have unit/browser checks. |
| Coordinates and forms | Three samples of 200 coordinate toggles and 200 real DOM input events per width. Final median work: toggles 59.1/58.7 ms; form edits 24.3/23.1 ms. Reversible toggles leave the same DOM and retain no extra listeners/nodes. Typed input is checked against controller state. |
| Score estimator | Actual local WASM engine, not a canned result: six timed requests took 178–193 ms to an observed result; maximum observed main-thread frame gap was 33.3 ms. Every result had territory and every completion/cancellation terminated its worker. Each timed sample also completed six further estimates. Loading is surveyed separately. |
| Estimator memory | A further 60 completed estimates per width, returning to the game and collecting garbage after each. All 120 retained exactly 312 nodes and 217 listeners after first use. Each page created and terminated 60 workers; CDP reported zero worker targets at the end. Main heap increased 4,297,280 → 4,725,132 bytes on desktop and 4,292,940 → 4,719,236 bytes at narrow width, so the report does not claim perfectly flat heap usage. |
| Heap attribution | A separate desktop heap-snapshot comparison after estimates 10 and 60 found the largest reachable shallow-size increases in V8 `code` (+156,696 bytes), the same-count WASM native-module group (+95,899 bytes), and browser paint/resource/performance records. Generic JavaScript objects increased by six objects/120 bytes. This does not demonstrate an application-object leak and does not justify a speculative memory-management change. |
| Counting | Waiting, incoming request, accepted, result, rejected and error screens; both Accept and Reject on request and result screens at both widths (8 actions). Controls correctly become disabled while awaiting a response. With a result dialog and 166 territory markers visible, 200 clock ticks caused zero DOM mutations; median work was 37.4/32.9 ms. Browser tests supply result/confirmation responses and verify subsequent transitions. |
| IndexedDB and downloads | 1,000 valid synthetic frames persisted in 100-frame batches per width; exactly 1,000 records read back. Write/flush took 45.5/34.8 ms, serialization/read 7.4/7.6 ms (one sample each, not a statistical comparison). Both 325,001-byte log downloads parse correctly, and both 599-byte finished-game downloads begin with SGF syntax. Existing storage tests cover retention budgets, reloads, batching and failure behavior. |
| Other browser/runtime behavior | Full browser suite covers remembered credentials/cookies, focus, fullscreen guards, responsive layouts, matchmaking selection/locking, dialogs, SGF, and audio activation/teardown. Six production-network recordings check 6,047 packets and final UI goldens, including rejoin, opponent disconnection/reconnection, counting rejection and multiple games. |

Validation after the changes: `npm test` (236 unit tests, browser checks, 5
integration-harness tests, six production replays, 86 Docker visual checks),
`npm run typecheck`, and `npm run build`. Visual baselines are unchanged.

Coverage limits: fixture load times include synthetic scenario setup and an
extra test-driver bundle, so they are not cold-start/page-load benchmarks. The
stopped-clock idle tests isolate unscheduled work; clock advancement is measured
separately. Player-history HTTP responses and Fox WebSockets are offline inputs;
real server availability, latency and large live histories are not measured.
The six recorded logs still lack a real counting-result acceptance recording;
fixture/browser tests cover that transition. Memory measurements cover the main
renderer heap and worker lifecycle, not worker peak memory, GPU memory or
multi-hour sessions. No claim is made for other browser engines or physical
mobile devices. No additional runtime changes were made without measured
redundant work and a matching before/after comparison.
