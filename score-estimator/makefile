.PHONY: build setup inputs tools test check-instructions clean

PYTHON ?= python3
VENV ?= .venv
OUT ?= build

CLANG ?= $(if $(WASI_SDK_PATH),$(WASI_SDK_PATH)/bin/clang,clang)
WASM_OPT ?= $(if $(BINARYEN_ROOT),$(BINARYEN_ROOT)/bin/wasm-opt,wasm-opt)

build: tools inputs
	"$(VENV)/bin/python" scripts/lift.py --out "$(OUT)" --clang "$(CLANG)" --wasm-opt "$(WASM_OPT)" --install

inputs: setup
	"$(VENV)/bin/python" scripts/fetch-inputs.py

setup: $(VENV)/.requirements-installed

$(VENV)/.requirements-installed: scripts/requirements.txt
	$(PYTHON) -m venv "$(VENV)"
	"$(VENV)/bin/python" -m pip install --require-hashes --only-binary=:all: -r scripts/requirements.txt
	touch "$@"

tools:
	@command -v "$(CLANG)" >/dev/null || { echo 'Set WASI_SDK_PATH or CLANG to the WASI SDK 30 compiler.' >&2; exit 1; }
	@command -v "$(WASM_OPT)" >/dev/null || { echo 'Set BINARYEN_ROOT or WASM_OPT to Binaryen 133.' >&2; exit 1; }

check-instructions: tools inputs
	"$(VENV)/bin/python" -m pip install unicorn==2.1.4
	"$(VENV)/bin/python" scripts/check-instructions.py --out "$(OUT)/instructions" --clang "$(CLANG)" --wasm-opt "$(WASM_OPT)"

test:
	cd .. && npm run test:score-estimator

clean:
	rm -rf "$(OUT)" "$(VENV)"
