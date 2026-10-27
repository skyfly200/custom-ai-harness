# Interceptor: the API on port 3000 and the /ui pages. See docker-compose.yml.
FROM node:22-slim
# git: chat repo linking; npx (already here) runs most MCP servers
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js caveman-compress.js validate-config.js ./
COPY utils ./utils
COPY migrations ./migrations
COPY scripts/migrate.js ./scripts/migrate.js
COPY ui ./ui
COPY config.yaml ./
EXPOSE 3000
CMD ["node", "server.js"]
