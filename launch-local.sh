#!/usr/bin/env bash
# launch-local.sh — Phase 4 hardened local engine launcher
#
# Starts a local model server (llama.cpp or vLLM) with strict anti-looping
# parameters: explicit context limit, layer offloading, and reasoning budget.
#
# Usage:
#   ./launch-local.sh llama   [model_path]   # llama.cpp server
#   ./launch-local.sh vllm    [model_id]     # vLLM server
#   ./launch-local.sh qwen    [model_path]   # Qwen Coder via llama.cpp
#   ./launch-local.sh gemma   [model_path]   # Gemma 4 via llama.cpp
#
# All servers bind to 127.0.0.1:8000 — the Tier 1 target in config.yaml.

set -euo pipefail

ENGINE="${1:-llama}"
MODEL="${2:-}"

# ---------------------------------------------------------------------------
# Shared anti-looping / resource parameters
# ---------------------------------------------------------------------------
CONTEXT_SIZE=8192          # -c  : hard context window cap (prevents runaway loops)
GPU_LAYERS=99              # -ngl: offload all layers to GPU; reduces CPU loop risk
REASONING_BUDGET=2048      # reasoning token budget (vLLM / llama.cpp thinking models)
THREADS=8                  # CPU thread count for llama.cpp
PORT=8000

# ---------------------------------------------------------------------------
# llama.cpp server — used for Qwen Coder, Gemma 4, and generic GGUF models
# ---------------------------------------------------------------------------
launch_llamacpp() {
    local model_path="${1:?model_path required for llama.cpp}"
    echo "Starting llama.cpp server: $model_path"
    exec llama-server \
        --model        "$model_path" \
        --ctx-size     "$CONTEXT_SIZE" \
        --n-gpu-layers "$GPU_LAYERS" \
        --threads      "$THREADS" \
        --host         127.0.0.1 \
        --port         "$PORT" \
        --no-mmap \
        --log-disable
        # --no-mmap    : avoids mmap-related loop/hang on large models
        # --log-disable: suppresses verbose stdout that inflates shell buffers
}

# ---------------------------------------------------------------------------
# vLLM server — used when HF model IDs are preferred over GGUF
# ---------------------------------------------------------------------------
launch_vllm() {
    local model_id="${1:?model_id required for vLLM}"
    echo "Starting vLLM server: $model_id"
    exec python -m vllm.entrypoints.openai.api_server \
        --model                    "$model_id" \
        --max-model-len            "$CONTEXT_SIZE" \
        --max-num-seqs             4 \
        --reasoning-budget         "$REASONING_BUDGET" \
        --trust-remote-code \
        --host                     127.0.0.1 \
        --port                     "$PORT"
        # --max-num-seqs 4         : caps concurrent sequences, limiting loop amplification
        # --reasoning-budget       : hard-stops thinking-mode runaway
}

# ---------------------------------------------------------------------------
# Named presets
# ---------------------------------------------------------------------------
case "$ENGINE" in
    qwen)
        MODEL="${MODEL:-models/qwen2.5-coder-7b-instruct-q5_k_m.gguf}"
        launch_llamacpp "$MODEL"
        ;;
    gemma)
        MODEL="${MODEL:-models/gemma-4-9b-it-q5_k_m.gguf}"
        launch_llamacpp "$MODEL"
        ;;
    llama)
        launch_llamacpp "$MODEL"
        ;;
    vllm)
        launch_vllm "$MODEL"
        ;;
    *)
        echo "Unknown engine: $ENGINE  (valid: llama | vllm | qwen | gemma)" >&2
        exit 1
        ;;
esac
