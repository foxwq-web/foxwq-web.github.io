# Running the prototype

From the repository root:

```sh
python3 -m foxclient
```

This starts the client at **http://127.0.0.1:8765** and opens your browser. Python 3.10 or newer is required; there are no Python runtime dependencies and no compilation step. The excluded decompilation exports are not needed to run the client or its offline tests.

1. Keep `creds` in the project root, with the account name on the first line and password on the second.
2. Click **Log in with creds**. Wait for **Connected to Fox**.
3. Click **Find normal match**. The client selects the server-advertised **19×19, 20 minutes, 3×60 seconds** field.
4. Click intersections on your turn. Pass, resign, request scoring, and save SGF from the sidebar.
5. After a connection failure or restart, log in again. Fox's game-lock query locates the existing game; operation 501 restores the moves, colour, clocks, and synchronization value.

Credentials and session tokens are not returned to the browser or included in application logs. `creds`, diagnostic traffic, and browser screenshots are ignored by Git. The HTTP server binds to loopback and requires a per-process token for actions. Diagnostic scripts write raw account/game traffic to the ignored local `analysis/live/` directory. Those files are not included in the repository.

Options:

```sh
python3 -m foxclient --no-browser --port 8765 --creds /path/to/creds
python3 -m foxclient --fox-host 43.132.13.39 --fox-port 10000
```

The navigation fallback above was observed in the installed client and successfully used during testing. Game gateway addresses come from Fox's server list, rather than being hard-coded.

## Historical validation recorded for 2026-10-06

The following describes the original validation session, not a new live check of the current server.

The prototype authenticated using the supplied test account, logged into the game gateway and room manager, discovered normal field **101**, matched with a live opponent, sent and received moves, passed, disconnected and resumed the active game, continued playing, and resigned. Fox acknowledged resignation with operations **311, 402, 403**. The completed test had **14 moves including one pass**. Its resignation result was **W+R**.

The browser was tested in installed Chrome: board clicks, two passes, local scoring, SGF download, and live login with the normal-match button enabled. No extra tools were installed for these checks.

```sh
python3 -m unittest protocol.test_framing -v
python3 -m unittest discover -s tests -v
mkdir -p analysis/live
python3 scripts/browser_check.py                 # macOS Chrome + running UI; local only
python3 scripts/browser_check.py --live          # additionally authenticates the account
```

The original run reported five framing tests and nine client tests passing. The commands above rerun the offline tests against your checkout. The TCP simulator covers fragmented login responses, duplicate server-list responses, the observed start-before-room-entry ordering, moves, pass, environment restoration, and resignation. It uses synthetic account/session identifiers.

## Prototype limits

This is a working minimal client, with these limits:

- Live scoring negotiation is implemented from the original request builders but has **not been validated through a completed scored game**. Local scoring is Chinese area scoring with manually marked dead groups; it does not establish Fox scoring compatibility.
- Normal fixed-setting matchmaking was verified. Custom invitations and automatic rule negotiation are outside the tested path.
- Clocks are estimates between server updates. Exhausting byoyomi and automatic time forfeits were not tested.
- Undo requests and unusual board/handicap variants are not implemented. The UI targets the requested ordinary 19×19 field.

The client remains a development prototype. It does not retry failed moves automatically: if an action is unconfirmed, it fetches the authoritative environment before allowing another action.
