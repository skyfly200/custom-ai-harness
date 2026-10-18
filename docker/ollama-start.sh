#!/bin/sh
# Ollama in Docker: start the server, then download each model in LOCAL_MODELS
# (space or comma separated) that isn't there yet. Models stay in the volume.
ollama serve &
until ollama list >/dev/null 2>&1; do sleep 1; done
for model in $(echo "${LOCAL_MODELS:-}" | tr ',' ' '); do
    ollama show "$model" >/dev/null 2>&1 || ollama pull "$model" || echo "couldn't download $model"
done
wait
