# Visual regression coverage

Run `npm run test:visual` from the repository root. The runner uses the pinned
Docker image, Chromium, fonts and viewport sizes used in CI. Desktop and mobile
screenshots compare with zero pixel tolerance. Locally the run uses one worker
per available CPU; set `VISUAL_WORKERS=N` to override (CI keeps three workers).

The suite renders the 19 screens in the app's Dev menu, once per project
(`?dev-screen=<id>`). Each test also checks the screen's key layout invariants
before comparing its full-page screenshot. The index in
`client/tests/visual/baselines/desktop/README.md` (and `mobile/README.md`)
lists the covered screens. Archived previews redirect to
`/game/<encoded-game-id>?dev-screen=<id>`; no preview requires Fox
credentials or an external game-record request. Product snapshots hide the
Dev menu via `product-snapshot.css`.

Behavioral and integration coverage lives in the unit tests
(`npm run test:unit`) and the recorded-session replays
(`npm run test:integration`).

## Updating baselines

After reviewing an intentional visual change, run:

```sh
npm run test:visual -- --update-snapshots
```

Inspect the changed PNGs and run the same command without
`--update-snapshots` to verify it. Use the Docker runner for baseline updates;
native browser fonts can produce different pixels. Failed comparisons and page
snapshots are written under `client/tests/visual/results/`.

All dev lobby tables share the lobby responses paired with `fox-network-log-20261103T2155-name-lookup.golden.json`. `client/src/dev-lobby-recording.json` contains only the corresponding room-list and player-list messages from its network recording; previews replay them through the production decoders.
