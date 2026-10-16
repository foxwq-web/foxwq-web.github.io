# Browser client

All FOX protocol logic and game state run in the browser. The only server code is
[proxy/index.js](../proxy/index.js), an authenticated WebSocket/TCP relay. It
forwards binary bytes without interpreting FOX packets. Static files can be
served by any static host; Node.js is needed only for development and builds.

## Run locally

```sh
npm install
npm start
```

Open **http://127.0.0.1:5173**. Enter your FOX username and password, expand
**Proxy settings**, and enter the Worker URL and access token. Deploy your own relay using the instructions below. Deployment writes its
URL to ignored `.env.local`, so the URL field is filled automatically. After deployment, the access
token is in ignored `proxy/.dev.vars`; copy only the value of `PROXY_TOKEN`.
The token is an access credential for this proxy, not your Cloudflare API token.

Click **Log in to FOX**, wait for **Connected to Fox**, then **Find normal match**.
The browser selects the advertised 19×19, 20 min + 3×60 s field. Play, pass,
resign, request scoring, and export SGF from the sidebar. Login after a connection
failure restores an existing game using FOX's game-lock query and operation 501.
The **New local game** button works without the proxy or FOX credentials.

FOX credentials, session tokens, and the proxy token are held in browser memory;
the password field is cleared after login. Nothing is saved in browser storage.
Reloading closes connections; log in again to resume. SGF downloads are generated
locally using a Blob, with no HTTP API. FOX's password hash and session data pass
through the relay as opaque protocol bytes. WSS encrypts the browser-to-Worker
connection; the Worker-to-FOX connection uses FOX's existing plain TCP protocol.

## Worker deployment

```sh
npm run proxy:deploy
```

Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment, or use the
ignored `cloudflare-creds` file containing those assignments. The deployment
script uploads the relay, sets a random `PROXY_TOKEN` secret, saves that token
privately in `proxy/.dev.vars`, and configures the public URL in `.env.local`.
It never reads FOX account credentials.

The Worker accepts `/proxy?host=HOST&port=PORT` upgrades using the offered
subprotocols `tcp-proxy` and the access token; only `tcp-proxy` is echoed.
Messages in both directions contain raw binary stream chunks. The browser
handles partial and multiple FOX frames per chunk. The Worker serializes TCP
writes, bounds pending writes, and closes both sides on errors or disconnects.
`GET /health` reports relay availability without opening a TCP connection.

`proxy/wrangler.jsonc` defines generic comma-separated allowlists:

- `ALLOWED_ORIGINS`: exact static application origins, including the port.
- `ALLOWED_TARGETS`: exact `host:port` TCP destinations. Initially navigation
  `43.132.13.39:10000` and the previously observed gateway `119.91.247.46:3001`.

FOX may advertise a new gateway. Its address appears in Connection activity. Add its address to `ALLOWED_TARGETS` and redeploy.
The relay deliberately does not parse discovery responses or update policy itself.
For local relay development, `npm run proxy:dev` reads `proxy/.dev.vars`; use
`ws://127.0.0.1:8787/proxy` in the browser's proxy settings.

## Static production build

```sh
npm run build
npm run preview
```

Upload **only `dist/`** to your static host. Add that site's exact HTTPS origin
to `ALLOWED_ORIGINS` and redeploy the relay. Set `VITE_FOX_PROXY_URL` before
building to prefill the public proxy address. Do not embed access tokens in
`VITE_` variables or publish credential files. A user supplies the proxy token
in the login form. `npm start` and `npm run preview` are development static
servers; there is no application backend or `/api` endpoint.

## Validation and limitations

Decompilation exports are excluded and are not needed for these tests. Historical live checks below have not been repeated as part of the documentation review.

```sh
npm test
node scripts/browser-check.js           # running npm start; local game only
node scripts/browser-check.js --live    # also logs in through deployed relay
```

The original validation record reports that on 2026-10-08, the browser passed local board, pass, scoring, and SGF checks,
and authenticated through the deployed Cloudflare relay to FOX navigation, gateway,
and room discovery. Normal matchmaking availability was confirmed without
starting a live game. All eight automated tests passed, including a Worker
test against a generic TCP echo server.

JavaScript tests cover wire formats, compression and frame boundaries, legal Go
moves, scoring, SGF, scoring confirmation messages, stale connection handling,
and a simulated two-connection browser flow through login, matching, moves,
passing, resumption, and resignation. The original Python implementation was
validated against FOX on 2026-10-06; those historical live game results do not
establish that every JavaScript path has been tested live.

Live scoring through a completed scored game remains unverified. Local scoring
uses Chinese area scoring and manually marked dead groups. Custom invitations,
unverified rule negotiation, undo, handicap variants, and automatic time forfeits
remain outside the verified path. Clocks are estimates between server updates.
Unconfirmed moves trigger authoritative game synchronization rather than retries.
Browser background-tab timer throttling and Worker restarts can interrupt a
session; logging in again restores an active game.
