# Gateway (LiteLLM proxy), built on python:3.12-slim so it runs on ARM servers too
FROM python:3.12-slim
ARG LITELLM_VERSION=""
RUN pip install --no-cache-dir "litellm[proxy]${LITELLM_VERSION:+==$LITELLM_VERSION}"
WORKDIR /app
COPY config.yaml ./
COPY docker/gateway-start.py /usr/local/bin/gateway-start.py
ENV PYTHONUTF8=1
EXPOSE 4000
# Builds the running config from config.yaml and the launch settings in .env
CMD ["python", "/usr/local/bin/gateway-start.py"]
