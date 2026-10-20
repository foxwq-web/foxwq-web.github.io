# Client

A browser client for Fox Go. The React/TypeScript client handles login, matchmaking, gameplay, clocks, counting requests, and SGF export. A Cloudflare Worker relays binary WebSocket traffic to Fox's TCP servers; it does not implement the game protocol.

## Development

Use Node **26.11.0** and npm **12.2.0**, as pinned in `.node-version` and `package.json`.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite, normally `http://127.0.0.1:5173`. The app uses the proxy configuration in [client/src/proxy.ts](src/proxy.ts); set `VITE_FOX_PROXY_URL` in a local `.env.local` to override its URL, then restart Vite. Live login requires a reachable proxy with matching token, origin, and destination settings.

Enter your Fox account in the login dialog and select a time control after connecting. An existing game can be restored on login. **Remember credentials** stores the username and password in a JavaScript-readable cookie for 30 days. The app also remembers the selected time control in a cookie.

For offline UI previews, open `/?dev-screen=all` on the development server. Preview shortcuts are development-only. They exercise UI states without requiring a live Fox game.

## Build and verification

Run these commands from the repository root:

```sh
npm test
npm run typecheck
npm run build
```

The static app is built into `client/dist/`. Serve that directory with a static host; `npm run preview` previews the build locally. The Worker is deployed separately.

Browser checks start their own local server:

```sh
npm run test:browser:install
npm run test:browser
```

The [CI workflow](../.github/workflows/ci.yml) runs verification on pushes and pull requests. Offline tests and previews do not establish current Fox server availability or compatibility with every live game path.
