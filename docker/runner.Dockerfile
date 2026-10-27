# Task runner (runner/server.js): the Runs page's agents. See docker-compose.yml.
# The runner needs git to pack a run's base commit into a bundle for the sandbox
# and to fetch the branch back. Its agents' commands run in the E2B sandbox
# (RUNNER_SANDBOX=e2b), not here, so this image needs no language toolchains.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# ./repos is bind-mounted from the server, so its files belong to another user;
# without this git refuses them as "dubious ownership" and every run fails to start
RUN git config --system --add safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY utils ./utils
# utils/runCost.js prices a run with the page's own cost and token code
COPY ui/costs.js ui/tokens.js ./ui/
COPY workflows ./workflows
COPY runner ./runner
EXPOSE 3100
CMD ["node", "runner/server.js"]
