#!/usr/bin/env bash
# launch-laya.sh — self-hosted Laya classifier for the Router's `systemone` backend
#
# Runs `laya-serve` (https://github.com/NandhaKishorM/laya) on CPU. The Router
# posts each prompt to {base_url}/v1/systemone and reads P(needs a strong model).
#
# Usage:
#   ./launch-laya.sh            # pip install, then serve on 127.0.0.1:8001
#   ./launch-laya.sh docker     # same server from Laya's own CPU Docker image
#
# Port 8001, because the Tier 1 local engine (launch-local.sh) already has 8000.
# On another machine: LAYA_HOST=0.0.0.0 LAYA_API_KEY=<secret> ./launch-laya.sh,
# then set base_url and api_key_env in routellm-config.yaml.
# First start downloads the English checkpoint from Hugging Face (~600 MB).

set -euo pipefail

export LAYA_HOST="${LAYA_HOST:-127.0.0.1}"
export LAYA_PORT="${LAYA_PORT:-8001}"
export LAYA_DEVICE=cpu
export LAYA_MODELS="${LAYA_MODELS:-english}"   # routing prompts are English; skip the multilingual checkpoint
export LAYA_PRELOAD=1                          # load at startup, not on the first routed request
export LAYA_THREADS="${LAYA_THREADS:-4}"       # keep at or below physical cores

launch_pip() {
    if ! command -v laya-serve >/dev/null; then
        echo "Installing laya[serve] with CPU-only PyTorch"
        pip install --index-url https://download.pytorch.org/whl/cpu torch
        pip install "laya[serve]"
    fi
    echo "Starting laya-serve on http://$LAYA_HOST:$LAYA_PORT"
    exec laya-serve
}

launch_docker() {
    local src="${LAYA_SRC:-.laya}"
    [ -d "$src" ] || git clone --depth 1 https://github.com/NandhaKishorM/laya "$src"
    # Inside the container the server listens on all interfaces; LAYA_HOST picks the host side.
    export LAYA_BIND_ADDRESS="$LAYA_HOST" LAYA_HOST=0.0.0.0
    cd "$src"
    exec docker compose -f compose.yaml -f compose.http.yaml up --build laya-serve
}

case "${1:-pip}" in
    pip)    launch_pip ;;
    docker) launch_docker ;;
    *)      echo "Unknown mode: $1  (valid: pip | docker)" >&2; exit 1 ;;
esac
