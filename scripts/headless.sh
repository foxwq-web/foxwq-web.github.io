#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
ghidra_headless="$(brew --prefix ghidra)/libexec/support/analyzeHeadless"
exec "$ghidra_headless" analysis/ghidra Fox -scriptPath scripts "$@"
