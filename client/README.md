# Client

A browser client for Fox Go. The React/TypeScript client handles login, matchmaking, gameplay, clocks, counting requests, score estimation, SGF export, and downloadable network logs. A Cloudflare Worker relays binary WebSocket traffic to Fox's TCP servers; it does not implement the game protocol.

## Development

Use Node **26.11.0** and npm **12.2.0**, as pinned in `package.json`.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite, normally `http://127.0.0.1:5173`. The app uses the proxy configuration in [client/src/proxy.ts](src/proxy.ts); set `VITE_FOX_PROXY_URL` in a local `.env.local` to override its URL, then restart Vite. Live login requires a reachable proxy with matching token, origin, and destination settings.

Enter your Fox account in the login dialog and select a time control after connecting. An existing game can be restored on login. **Remember credentials** stores the username and password in a JavaScript-readable cookie for 30 days. The app also remembers the selected time control in a cookie.

Hover a player name during a game or in matchmaking to see their rank progress, up to 20 results at their current rank, and last 10 games. Keyboard focus or tapping the name also opens the card; Escape dismisses it. Details use Fox's authenticated gateway, while the game list uses one HTTP request signed in the client with the logged-in UID and login token; the proxy forwards that request to Fox unchanged. Both requests start in parallel in the background after login and when players join a game, and refresh after the game ends. Hover reuses pending requests and cached results; completed cards open immediately. Cached data stays visible while refreshing after a minute. The Worker must include the `/fox/chessbook/TXWQFetchChessList` route.

Press **F** to enter or leave full screen when you are not typing in a form field.

For offline UI previews, open `/?dev-screen=all` on the development server. Preview shortcuts are development-only. They exercise UI states without requiring a live Fox game.

## Build and verification

Run these commands from the repository root:

```sh
npm run test:browser:install # First-time browser setup
npm test
npm run typecheck
npm run build
```

`npm test` runs the unit, browser, and visual suites in order, stopping on the
first failure. Docker must be running for the visual suite. Run an individual
suite with `npm run test:unit`, `npm run test:browser`, or `npm run test:visual`.

The static app is built into `client/dist/`. Serve that directory with a static host; `npm run preview` previews the build locally. The Worker is deployed separately.

Browser checks start their own local server and mute audio:

```sh
npm run test:browser:install
npm run test:browser
```

Run `npm run test:visual` with Docker running to compare every dev screen with
the PNGs in `client/tests/visual/baselines/`. The test starts its own server in
the pinned Playwright Linux/amd64 image, matching CI's browser and fonts.
Docker builds and caches a test image with the Node and npm versions from
`package.json`; the first run downloads the runtime and installs the pinned npm.
Every dev screen is captured at desktop (1280 × 900) and mobile (390 × 844)
sizes, with touch and mobile emulation enabled for mobile. Baselines are grouped
under `desktop/` and `mobile/`. Both use UTC and a fixed date. The score preview
uses the real local engine; player info previews wait for their sample data.

Missing or changed screenshots fail without modifying the recorded baselines.
Failures save actual, expected, and diff images in `client/tests/visual/results/`.
Review them, then accept intentional changes using Playwright's standard update
command: `npm run test:visual -- --update-snapshots`. Rerun the comparison and
commit the updated PNGs alongside the code. New dev screens are automatically
included; the same update command records their first baselines. To run or
update a subset, add `--grep counting` to either command. Add `--project mobile`
or `--project desktop` to select a viewport.
CI runs the comparisons and uploads
failure images as an artifact. `npm run test:visual:run` runs directly on the
host for debugging; its rendering may differ from the recorded Linux images.

The [CI workflow](../.github/workflows/ci.yml) runs unit and browser tests in the verification job and visual tests in a separate job on pushes and pull requests. Offline tests and previews do not establish current Fox server availability or compatibility with every live game path.

## GitHub Pages

The app is configured for https://foxwq-web.github.io/ in the `foxwq-web/foxwq-web.github.io` repository. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.

[Publish GitHub Pages](../.github/workflows/pages.yml) runs on pushes to `main` and can also be started manually from the Actions tab on `main`. It installs the pinned Node/npm dependencies, uses the checked-in scoring WASM, builds the client, and uploads only `client/dist/` for deployment. Vite uses `/` as the asset base. Client build output is ignored by Git; commit source changes and push to `main` to publish. No generated bundles, branch build commits, or `.nojekyll` file are needed. Edit CSS in `client/public/style.css`.

The Pages workflow deploys the static app independently of Verify. Build-time `VITE_*` settings are embedded in the app; an optional repository Actions variable `VITE_FOX_PROXY_URL` overrides the default production proxy URL. If deploying the Worker into a different Cloudflare account, set this variable to the resulting `wss://<worker>.<subdomain>.workers.dev/proxy` URL and rerun the Pages workflow; the deployment script's `.env.local` file exists only on the CI runner.

## Logs

Network logs persist across page reloads in IndexedDB. New redacted records are written in small batches, with a shared 20 MiB retention budget across tabs and a 1 MiB pending-write limit. Oldest records are dropped when the budget is exceeded; oversized records are skipped. If IndexedDB is unsupported or fails, network logging stops. There is no migration or in-memory fallback.

Network-log downloads wait for pending writes and contain timestamps, source/destination, and base64 payloads. Login/session traffic is redacted before persistence; remaining entries can contain game and account identifiers. SGF and network-log downloads are generated in the browser. A crash can lose the most recent uncommitted batch.

The normal browser suite includes IndexedDB checks. To run them separately, or against other installed Playwright engines:

```sh
npm run test:browser -- --network-log
FOX_LOG_BROWSERS=chromium,firefox,webkit npm run test:browser -- --network-log
```
