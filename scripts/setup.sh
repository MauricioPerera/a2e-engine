#!/usr/bin/env bash
# setup.sh — reproducible build for the product.
#
# Ensures the Activepieces monorepo is present at the pinned tag, installs its
# deps, installs the product's own workspace deps, then builds the engine bundle
# and the demo pieces required by the smokes.
#
# Env:
#   AP_REPO  – path to the Activepieces monorepo (default: $HOME/ap)
#   AP_TAG   – tag/branch of Activepieces to clone if AP_REPO is missing (default: 0.85.4)
#
# Requirements: node >= 20, bun (AP ships bun@1.3.3 in packageManager), git, npm.
# If /home/administrador/.hermes/node/bin exists it is prepended to PATH (bundled node+bun).
set -euo pipefail

AP_TAG="${AP_TAG:-0.85.4}"
AP_REPO="${AP_REPO:-$HOME/ap}"
PRODUCT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_BIN="/home/administrador/.hermes/node/bin"
if [ -d "$HERMES_BIN" ]; then export PATH="$HERMES_BIN:$PATH"; fi

log() { printf '\n=== %s ===\n' "$*"; }
die() { echo "SETUP FAIL: $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 (need node + bun on PATH)"; }

require node
require bun
require git
require npm

log "AP_REPO=$AP_REPO  AP_TAG=$AP_TAG  PRODUCT_DIR=$PRODUCT_DIR"

# 1) Activepieces monorepo --------------------------------------------------
if [ ! -d "$AP_REPO" ]; then
  log "Cloning Activepieces @ $AP_TAG into $AP_REPO"
  git clone --depth 1 --branch "$AP_TAG" https://github.com/activepieces/activepieces "$AP_REPO" \
    || die "git clone failed for tag $AP_TAG"
else
  echo "AP_REPO already present: $AP_REPO (skipping clone)"
fi

# 2) AP deps (esbuild and the @activepieces/* packages live here) -----------
if [ ! -d "$AP_REPO/node_modules" ]; then
  log "Installing Activepieces deps (bun install) — needs ~6GB, ~4min"
  ( cd "$AP_REPO" && bun install ) || die "bun install failed in $AP_REPO"
else
  echo "AP node_modules present (skipping bun install)"
fi

# 3) product workspace deps (tsx, etc.) ------------------------------------
if [ ! -d "$PRODUCT_DIR/node_modules" ]; then
  log "Installing product deps (npm install)"
  ( cd "$PRODUCT_DIR" && npm install ) || die "npm install failed in $PRODUCT_DIR"
else
  echo "product node_modules present (skipping npm install)"
fi

# 4) build engine + demo pieces --------------------------------------------
export AP_REPO
EA="$PRODUCT_DIR/packages/engine-adapter"

log "Building engine -> $EA/dist/engine.cjs"
( cd "$EA" && node build-engine.mjs ) || die "build-engine.mjs failed"
[ -f "$EA/dist/engine.cjs" ] || die "engine.cjs not produced"

log "Building demo pieces (json, echo, hook)"
for s in build-piece-json.mjs build-piece-echo.mjs build-piece-hook.mjs; do
  ( cd "$EA" && node "$s" ) || die "$s failed"
done

echo
echo "SETUP OK"
echo "engine.cjs: $EA/dist/engine.cjs"