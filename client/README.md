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

Press **F** to enter or leave full screen when you are not typing in a form field.

For offline UI previews, open `/?dev-screen=all&mute=1` on the development server. Preview shortcuts are development-only. They exercise UI states without requiring a live Fox game.

## Build and verification

Run these commands from the repository root:

```sh
npm test
npm run typecheck
npm run build
```

The static app is built into `client/dist/`. Serve that directory with a static host; `npm run preview` previews the build locally. The Worker is deployed separately.

Browser checks start their own local server and mute audio:

```sh
npm run test:browser:install
npm run test:browser
```

The [CI workflow](../.github/workflows/ci.yml) runs verification on pushes and pull requests. Offline tests and previews do not establish current Fox server availability or compatibility with every live game path.

## GitHub Pages

The app is configured for https://foxwq-web.github.io/ in the `foxwq-web/foxwq-web.github.io` repository. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.

[Publish GitHub Pages](../.github/workflows/pages.yml) runs on pushes to `main` and can also be started manually from the Actions tab on `main`. It installs the pinned Node/npm dependencies, uses the checked-in scoring WASM, builds the client, and uploads only `client/dist/` for deployment. Vite uses `/` as the asset base. Client build output is ignored by Git; commit source changes and push to `main` to publish. No generated bundles, branch build commits, or `.nojekyll` file are needed. Edit CSS in `client/public/style.css`.

The Pages workflow deploys the static app independently of Verify. Build-time `VITE_*` settings are embedded in the app; an optional repository Actions variable `VITE_FOX_PROXY_URL` overrides the default production proxy URL. If deploying the Worker into a different Cloudflare account, set this variable to the resulting `wss://<worker>.<subdomain>.workers.dev/proxy` URL and rerun the Pages workflow; the deployment script's `.env.local` file exists only on the CI runner.

## Logs

Network logs are stored locally across page reloads using bounded browser storage, with an in-memory fallback when storage is unavailable. Downloads contain timestamps, source/destination, base64 payloads, and build metadata. Login/session traffic is redacted by the logging code; remaining entries can contain game and account identifiers. SGF and network-log downloads are generated in the browser.
