
FROM python:3.13.7-slim-bookworm@sha256:781449467ffb6f04218f09b1ecdcdc7d22b289ee5da9ec498b024e24ad7a6db7 AS builder
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C.UTF-8
COPY scripts/install-toolchain.py scripts/toolchain.json /tmp/toolchain/
RUN python /tmp/toolchain/install-toolchain.py /opt
COPY scripts/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/requirements.txt
WORKDIR /estimator
COPY scripts/lift.py scripts/machine.h scripts/requirements.txt ./scripts/
COPY scripts/fetch-inputs.py scripts/inputs.json ./scripts/
RUN python scripts/fetch-inputs.py
RUN mkdir artifacts && python scripts/lift.py --out /tmp/score-build \
    --clang /opt/wasi-sdk/bin/clang --wasm-opt /opt/binaryen/bin/wasm-opt --install
RUN mkdir /export && cp artifacts/fox-score.wasm artifacts/fox-score-bindings.json scripts/report.json /export/

FROM scratch AS artifacts
COPY --from=builder /export/ /
