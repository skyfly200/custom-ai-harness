# Gateway (LiteLLM proxy), built on python:3.12-slim so it runs on ARM servers too
FROM python:3.12-slim
ARG LITELLM_VERSION=""
RUN pip install --no-cache-dir "litellm[proxy]${LITELLM_VERSION:+==$LITELLM_VERSION}"
WORKDIR /app
COPY config.yaml ./
ENV PYTHONUTF8=1
EXPOSE 4000
CMD ["litellm", "--config", "/app/config.yaml", "--host", "0.0.0.0", "--port", "4000"]
