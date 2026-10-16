# Fox client prototype

A minimal browser client for Fox Go, reconstructed from the reference Windows client. Start with [running instructions and limitations](docs/prototype.md), [implementation notes](docs/client-protocol.md), and [runtime protocol findings](docs/runtime-protocol.md).

The client runs in the browser; a Cloudflare Worker relays WebSocket traffic to Fox TCP connections. See [setup, relay deployment, and limitations](docs/prototype.md).

```sh
npm install
npm start
```

Vite's local development URL is printed in the terminal. Use your own deployed relay URL and proxy token; these are not included in a fresh clone.

```sh
npm test
npm run build
```

The implementation is under `src/`, with packet framing in [src/framing.js](src/framing.js). The [observational wire schema](protocol/recovered.proto) remains available for research. Earlier Python live-game checks are historical; see the prototype notes for JavaScript validation and limits.

## Optional local reverse engineering

Raw Ghidra pseudocode, disassembly, message indexes, inventory files, and serializer-expression evidence are excluded from Git. `analysis/`, `decompiled/`, and `protocol/wire-fields.json` are ignored local outputs; a fresh clone does not contain them. The browser client and automated tests do not need them.

The scripts remain available for local research with your own reference executable. `scripts/headless.sh` requires Homebrew installations of Ghidra and OpenJDK 21. To import the executable at its original local installation path:

```bash
mkdir -p analysis/ghidra
scripts/headless.sh \
  -import "$HOME/.foxweiqi/drive_c/Program Files (x86)/foxwq/foxwq/foxwq.exe" \
  -postScript Inventory.java "$PWD/analysis" \
  -analysisTimeoutPerFile 1200
```

After that import, individual functions can be exported locally without repeating analysis:

```bash
scripts/headless.sh -process foxwq.exe -noanalysis \
  -postScript Decompile.java "$PWD/analysis/scratch" 00745250 0073bdb0
```

This import and individual-function export do not recreate the full research dataset. `scripts/recover_wire_schema.py` requires the separately generated `analysis/message-vtables.json` and matching serializer exports under `decompiled/`. It cannot run from a fresh clone alone. Its `protocol/wire-fields.json` output contains serializer expressions and remains ignored. Exported C is Ghidra pseudocode, not compilable application source.

The included schema can be compiled independently if `protoc` is installed:

```bash
mkdir -p analysis
protoc --proto_path=protocol --descriptor_set_out=analysis/recovered.pb protocol/recovered.proto
```
