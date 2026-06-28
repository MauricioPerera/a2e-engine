#!/usr/bin/env bash
# sandbox-build.sh — bwrap-confined builder for T2 (untrusted) pieces.
#
# Runs the trusted toolchain (node + esbuild) to bundle ONE piece whose source
# is untrusted, inside a bubblewrap sandbox:
#   --unshare-all     : net + pid + ipc + uts + cgroup namespaces (NO network).
#   --die-with-parent : kill sandbox if the caller dies.
#   --clearenv        : drop ALL host env; set only minimal PATH, HOME (a tmpfs),
#                       and AP_REPO (build-piece.mjs resolves esbuild/aliases).
#   ro-bind           : ONLY the trusted toolchain + the piece dir (read-only).
#   bind (rw)         : ONLY <outRoot>; /tmp is a fresh tmpfs (writable, empty).
#   --chdir PIECE_DIR : esbuild cwd = the (read-only) piece dir. Makes the source
#                       path annotations in the bundle deterministic and identical
#                       to an in-process build run with cwd=PIECE_DIR.
#
# Host secrets (~/.ssh, ~/.env, /etc/...) are NOT bound -> invisible inside.
# No --ro-bind / : only the paths listed below exist in the sandbox.
#
# MOUNT ORDER NOTE: --tmpfs /tmp MUST come before any bind whose target is under
# /tmp (both pieceDir and outRoot are typically under /tmp). bwrap stacks mounts
# in arg order; a tmpfs on /tmp done AFTER such a bind would shadow it. tmpfs
# first -> those binds land on top, visible + writable to the host dir.
#
# MODES (3rd optional arg):
#   bundle  (default): exec build-piece.mjs   -> produces index.cjs ONLY.
#                      Confinement of the BUNDLE step only. The metadata
#                      extraction (require+.metadata()) still runs in-process
#                      on the host afterwards (CAVEAT, vector open).
#   process          : exec sandbox-process.mjs -> produces index.cjs AND
#                      metadata.json, BOTH inside the sandbox. sandbox-process.mjs
#                      runs buildPiece (esbuild) and THEN require(bundle).metadata()
#                      — the require of the untrusted bundle happens INSIDE the
#                      sandbox (net blocked, FS confined). The host only reads
#                      metadata.json (data), NEVER requires the bundle. This
#                      CLOSES the metadata-execution vector for T2_SANDBOX=1.
#
# Usage: sandbox-build.sh <pieceDir> <outRoot> [bundle|process]
# Env overrides: HERMES_NODE (node install), AP_REPO (activepieces repo),
#                ENGINE_DIR (engine-adapter dir), PSM_DIR (piece-source-manager dir).
set -euo pipefail

PIECE_DIR="${1:?usage: sandbox-build.sh <pieceDir> <outRoot> [bundle|process]}"
OUT_ROOT="${2:?usage: sandbox-build.sh <pieceDir> <outRoot> [bundle|process]}"
MODE="${3:-bundle}"
PIECE_DIR="$(readlink -f "$PIECE_DIR")"
OUT_ROOT="$(readlink -f "$OUT_ROOT")"
mkdir -p "$OUT_ROOT"

NODE_DIR="${HERMES_NODE:-/home/administrador/.hermes/node}"
AP_REPO="${AP_REPO:-$HOME/ap}"
ENGINE_DIR="${ENGINE_DIR:-$HOME/product/packages/engine-adapter}"
PSM_DIR="${PSM_DIR:-$HOME/product/packages/piece-source-manager}"
BUILD_PIECE="$ENGINE_DIR/build-piece.mjs"
SANDBOX_PROCESS="$PSM_DIR/scripts/sandbox-process.mjs"

# Sanity: every path we bind must exist on the host.
for p in "$NODE_DIR/bin/node" "$PIECE_DIR/src/index.ts" \
         "$AP_REPO/node_modules/esbuild/lib/main.js" "$AP_REPO/packages" \
         "$AP_REPO/tsconfig.base.json"; do
  [ -e "$p" ] || { echo "[sandbox-build] missing required path: $p" >&2; exit 2; }
done

# Runner + its required bindings depend on MODE.
RUNNER_ARGS=()
EXTRA_BINDS=()
case "$MODE" in
  bundle)
    [ -e "$BUILD_PIECE" ] || { echo "[sandbox-build] missing BUILD_PIECE: $BUILD_PIECE" >&2; exit 2; }
    EXTRA_BINDS+=( --ro-bind "$ENGINE_DIR" "$ENGINE_DIR" )
    RUNNER=( "$NODE_DIR/bin/node" "$BUILD_PIECE" "$PIECE_DIR" "$OUT_ROOT" )
    ;;
  process)
    [ -e "$BUILD_PIECE" ] || { echo "[sandbox-build] missing BUILD_PIECE: $BUILD_PIECE" >&2; exit 2; }
    [ -e "$SANDBOX_PROCESS" ] || { echo "[sandbox-build] missing SANDBOX_PROCESS: $SANDBOX_PROCESS" >&2; exit 2; }
    EXTRA_BINDS+=( --ro-bind "$ENGINE_DIR" "$ENGINE_DIR" )
    # sandbox-process.mjs lives in PSM scripts dir; bind it ro so the sandbox
    # can read (and import build-piece.mjs from the already-bound ENGINE_DIR).
    EXTRA_BINDS+=( --ro-bind "$PSM_DIR/scripts" "$PSM_DIR/scripts" )
    RUNNER=( "$NODE_DIR/bin/node" "$SANDBOX_PROCESS" "$PIECE_DIR" "$OUT_ROOT" )
    ;;
  *)
    echo "[sandbox-build] unknown MODE '$MODE' (expected bundle|process)" >&2
    exit 2
    ;;
esac

# Resource caps: 2.5GB virtual memory, 90s wall clock.
ulimit -v 2600000

# --clearenv drops PATH; we exec node by absolute path so bwrap's own execvp is
# unaffected. PATH inside is restored in case node spawns children.
timeout 90 bwrap \
  --unshare-all --die-with-parent \
  --clearenv \
  --setenv PATH "$NODE_DIR/bin:/usr/bin:/bin" \
  --setenv HOME /tmp \
  --setenv AP_REPO "$AP_REPO" \
  --ro-bind "$NODE_DIR" "$NODE_DIR" \
  --ro-bind /usr /usr \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --symlink usr/bin /bin \
  --ro-bind "$AP_REPO/node_modules" "$AP_REPO/node_modules" \
  --ro-bind "$AP_REPO/packages" "$AP_REPO/packages" \
  --ro-bind "$AP_REPO/tsconfig.base.json" "$AP_REPO/tsconfig.base.json" \
  "${EXTRA_BINDS[@]}" \
  --tmpfs /tmp \
  --ro-bind "$PIECE_DIR" "$PIECE_DIR" \
  --bind "$OUT_ROOT" "$OUT_ROOT" \
  --dev /dev \
  --proc /proc \
  --chdir "$PIECE_DIR" \
  -- "${RUNNER[@]}"