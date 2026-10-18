# Router (router.py). The default build is small and fits the systemone and llm
# backends (web calls). ROUTER_BACKENDS (or HARNESS_MODE, see docker-compose.yml)
# adds an in-process classifier, with CPU-only PyTorch (about 2 GB more, ~2 GB RAM):
#   routellm   RouteLLM's BERT checkpoint
#   laya       Laya (weights download from Hugging Face on first use)
FROM python:3.12-slim
ARG ROUTER_BACKENDS=""
WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn pyyaml httpx
RUN if echo "$ROUTER_BACKENDS" | grep -qE 'routellm|laya'; then \
        pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu; \
    fi
RUN if echo "$ROUTER_BACKENDS" | grep -q routellm; then pip install --no-cache-dir routellm; fi
RUN if echo "$ROUTER_BACKENDS" | grep -q laya; then pip install --no-cache-dir laya; fi
COPY router.py routellm-config.yaml ./
EXPOSE 6060
CMD ["python", "router.py", "--host", "0.0.0.0", "--port", "6060"]
