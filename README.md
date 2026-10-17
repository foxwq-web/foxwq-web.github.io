# Fox client prototype

A minimal browser client for Fox Go, reconstructed from the reference Windows client. Start with [running instructions and limitations](docs/prototype.md), [implementation notes](docs/client-protocol.md), and [runtime protocol findings](docs/runtime-protocol.md).

```sh
python3 -m foxclient
```

Python 3.10 or newer is required, with no Python runtime dependencies or compilation step. The client reads your local `creds` file and supports login, normal matchmaking (**20 min + 3×60 s**), moves, passing, resignation, reconnecting to an active game, and SGF export. Scored game completion remains unverified.

## Included implementation and notes

| File | Contents |
| --- | --- |
| [docs/client-protocol.md](docs/client-protocol.md) | Packet format, login fields, request IDs, matchmaking, and gameplay entry points |
| [docs/runtime-protocol.md](docs/runtime-protocol.md) | Mappings recorded during live prototype testing |
| [protocol/recovered.proto](protocol/recovered.proto) | Observational wire layouts; neutral field names and opaque nested messages |
| [protocol/framing.py](protocol/framing.py) | Packet and gateway-envelope encoding/decoding |
| [installed.log](installed.log) | Historical tool installation log |

## Offline verification

These tests do not require Fox credentials, a reference executable, or decompilation exports:

```sh
python3 -m unittest protocol.test_framing -v
python3 -m unittest discover -s tests -v
```

The [prototype notes](docs/prototype.md) record earlier browser and live-game validation and its limits. Those historical checks do not establish current server availability or scored-game compatibility.

## Optional local reverse engineering

Raw Ghidra pseudocode, disassembly, message indexes, inventory files, and serializer-expression evidence are excluded from Git. `analysis/`, `decompiled/`, and `protocol/wire-fields.json` are ignored local outputs; a fresh clone does not contain them. The Python client and offline tests do not need them.

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
