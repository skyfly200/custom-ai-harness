# Langfuse

See every model call grouped by chat or run. Back to the [README](../README.md).

## Langfuse (see every call, grouped by chat or run)

[Langfuse](https://langfuse.com) records each model call the Gateway makes: which model, tokens, cost, how long it took, and (if you choose) the prompt and reply. The harness groups calls by chat (Bright Chat) or by run (Runs page), and tags each with the client, the model, the strategy, whether Auto picked it, and the user who was logged in. Claude Code calls are grouped by its own session id. **Nothing is sent unless you set both keys.**

1. Get keys: sign up at [cloud.langfuse.com](https://cloud.langfuse.com) (free tier), make a project, then Settings, API Keys. Or run your own, below.
2. Add them to `.env`:

   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_HOST=https://us.cloud.langfuse.com   # only if your project is on the US cloud
   ```
3. Install the logger once into the `.venv` (Docker does this for you): `pip install langfuse`.
4. Restart. With `npm run all` the Gateway then starts through `docker/gateway-start.py`, which writes `.gateway-config.yaml` (your `config.yaml` plus the Langfuse callbacks; `config.yaml` itself is not touched). With Docker, `docker compose up -d --build`.

The Settings page shows a Langfuse box: off, connected (with a link to open it), or what is wrong (keys refused, unreachable).

**What is logged.** By default only metadata: model, tokens, cost, timing, tags. The text of your prompts and replies (which can include your code and files) stays out. To log it as well, tick "Langfuse: also log prompts and replies" on the Settings page; it applies from the next request, no restart. Or set `LANGFUSE_LOG_CONTENT=1` in `.env` as the starting value. The Gateway redacts text by default, so programs that call the Gateway directly (port 4000) are never logged with content.

**Your own Langfuse in Docker.** Needs about 3 GB of RAM (too much for a 1 GB server; use the cloud there). In `.env`:

```
COMPOSE_PROFILES=langfuse
LANGFUSE_HOST=http://langfuse-web:3000
LANGFUSE_URL=http://localhost:3001
LANGFUSE_SALT=any-long-random-text
LANGFUSE_ENCRYPTION_KEY=...            # openssl rand -hex 32
LANGFUSE_PUBLIC_KEY=pk-lf-harness      # you choose these; they are created on first start
LANGFUSE_SECRET_KEY=sk-lf-harness-change-me
LANGFUSE_INIT_USER_EMAIL=you@example.com
LANGFUSE_INIT_USER_PASSWORD=choose-a-password
```

Then `docker compose up -d --build` and open http://localhost:3001. The first start takes a minute or two. Combine with other profiles with commas (`COMPOSE_PROFILES=local,langfuse`).
