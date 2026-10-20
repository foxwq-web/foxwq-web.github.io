## Score estimator

This directory contains binary translation tools, checked-in WASM and bindings, runtime, and tests. The proprietary DLL inputs are not tracked. The client loads the WASM on demand for score estimation. The generated `score-estimator/artifacts/fox-score.wasm`, bindings, and audit report remain tracked so the client can use the existing engine if rebuilding becomes unavailable.

To rebuild using Docker with Buildx:

```sh
npm run score-estimator:build
npm run score-estimator:build -- --check
```

The build downloads the [official Fox installer](https://www.foxwq.com/soft/userguide.html?lang=en), extracts the two DLLs without running it, and verifies their pinned SHA-256 hashes before translation. Docker uses the pinned Linux/amd64 toolchain on all host platforms; no local Fox installation is needed. The installer and DLLs are only build inputs and are not exported. If Fox changes the DLL versions, the build fails rather than silently changing the engine.

The second command compares a rebuild with the checked-in WASM binary, bindings, and translator source hashes without installing the rebuilt files. The native alternative, `npm run score-estimator:build:native`, requires Python with venv support, WASI SDK 30, and Binaryen 133; see [makefile](makefile). Dependencies are installed into a local virtual environment. Native builds cache verified inputs in the ignored `score-estimator/dll/` directory. For offline native builds, place the matching DLLs there, or extract a downloaded installer with `score-estimator/.venv/bin/python score-estimator/scripts/fetch-inputs.py --installer /path/to/FoxWeiQi.exe`.

The estimate panel uses territory scoring even during a Chinese-rules game. In the original client, wrapper `006f7e40` passes zero for the Chinese-area flag to scorer `00593da0`, selecting rule data `011459b8` (prisoners: 100, live stones: 0, territory: 100). Each owned empty intersection counts once; an opposing stone counts twice, as territory and a prisoner. Existing captures count, and each false-eye penalty subtracts from its own color only. Live stones and neutral intersections contribute nothing. The game's komi is then subtracted from Black's lead; the rule table's default komi does not override the game's setting.

The Chinese-area branch of the same scorer credits live stones, fills isolated neutral holes near the end of the game, and allocates odd dame to the player to move. Applying that branch to the estimation panel caused the intermittent one-point discrepancy. The runtime tests include all five screenshot positions reported on 2026-10-20 and compare their displayed scores, in addition to the native ownership-map fixtures.

## Verification

From the repository root, run `npm run test:score-estimator` to check native ownership fixtures and the displayed-score regressions. CI rebuilds the scoring WASM and compares it with the checked-in artifacts before running tests. Local development and static deployment use those checked-in artifacts; Docker with Buildx is needed only to rebuild or verify them, with the native alternative described above.
