# Browser runtime benchmark

Run from the repository root with the pinned Node/npm and Playwright Chromium:

```sh
npm run bench:runtime -- /absolute/path/to/report.json
```

The runner builds production React and app code in a temporary directory. A
build-only driver exposes the existing controller and explicitly imports the
offline `board-black` fixture (38 stones). It never ships in `client/dist`.
External requests are blocked. No real login or Fox server is used.

At desktop (1280×900) and narrow (390×844) CSS viewports, each workload runs
in five fresh pages after 80 warmup events and asset preload. Each sample sends
720 clock events at quarter-second simulated increments, or 720 pointermove
DOM events across all intersections. `flushSync` forces one React commit per
state-changing event. This is an accelerated synchronous CPU stress test, not
an FPS, input latency, or paint-throughput measurement. Narrow viewport tests
use desktop Chromium, without mobile hardware or CPU emulation. `workMs`
excludes the two trailing animation frames used to settle DOM work.

MutationObserver records actual DOM writes and their target attributes. Build-only
counters record App/BoardView/Stone function calls. CDP reports task, layout,
style, node, listener and post-GC heap deltas. Clock CPU profiles are sampled
separately after timed samples; the report includes the top function/line hits.
Instrumentation adds overhead equally to each revision. Do not interpret
absolute timings as a production responsiveness guarantee.

An additional two-second idle check holds the game clock stopped to isolate
unscheduled activity. Eight further 720-pointer blocks in the same page,
collecting garbage after each, check whether retained nodes/listeners/heap keep
growing. Initial post-warmup heap deltas alone are not evidence of a leak.
Reports record the runtime, browser and CPU. Compare median work times, all
individual samples, deterministic call/mutation counts and final DOM state.

Checked-in reports in `results/` retain raw samples for this investigation.
The baseline had 6,480 hidden radio-input attribute writes per 720 clock ticks
and 27,360 unchanged Stone renders; desktop median work time was 59.6 ms for
clock ticks and 65.5 ms for pointer movement. These measurements establish the
specific redundant work addressed by subsequent commits.

Run the full feature survey and estimator memory investigation separately:

```sh
npm run bench:runtime -- --survey /absolute/path/to/survey.json
npm run bench:runtime -- --soak /absolute/path/to/estimator-soak.json
npm run bench:runtime -- --heap /absolute/path/to/estimator-heap.json
```

The survey uses all 35 fixtures at both viewports. It restores their prompts,
coordinates, player cards and variations, checks expected phases/overlays, and
measures a 200 ms stopped-clock idle window. It then runs three fresh samples of
200 history open/close pairs, replay/variation moves, coordinate toggles, form
edits, and clock events with each player card, counting, estimation, byoyomi and
coordinates visible. It asserts repeated reversible interactions leave the same
DOM/node/listener counts and board-position checksum. Clock workloads for lobby
cards are stress tests; matchmaking does not normally schedule game-clock ticks.

Real-estimator checks replace the offline response with the actual WASM worker,
measure request-to-result time and main-thread frame gaps, cancel a second
request, then complete six more requests. Worker construction/termination counts
are instrumented separately from CDP DOM/listener/post-GC heap counters.
Counting-request and counting-result each exercise both Accept and Reject.
The storage workload persists 1,000 valid synthetic frames in 100-frame batches,
reads them back, and verifies both the network-log and finished-game SGF downloads.

`--soak` completes 60 real estimates per viewport in one page, collecting garbage
after each return to the game. It asserts fixed DOM-node/listener counts, matching
positions, terminated workers and zero remaining CDP worker targets. `--heap`
uses desktop only and compares heap snapshots after requests 10 and 60, grouping
shallow retained sizes by V8 node type and object/closure class. Heap-snapshot
profiling is separate from timed interaction samples.

[Findings and coverage](FINDINGS.md) summarize the measured results and limits.
