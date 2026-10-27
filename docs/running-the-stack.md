# Running the stack by hand

Start the local engine, Gateway, Router and Interceptor one at a time. Back to the [README](../README.md).

## Running the stack

Open four terminal sessions (or use a process manager like `pm2` / `tmux`).

### 1. Local engine _(optional — skip if routing entirely to cloud fallbacks)_

**macOS / Linux**
```bash
# Qwen Coder
./launch-local.sh qwen models/qwen2.5-coder-7b-instruct-q5_k_m.gguf

# Gemma 4
./launch-local.sh gemma models/gemma-4-9b-it-q5_k_m.gguf
```

**Windows (PowerShell)**
```powershell
# llama.cpp must be on PATH or provide the full path to llama-server.exe
# Qwen Coder
llama-server --model models\qwen2.5-coder-7b-instruct-q5_k_m.gguf `
             --ctx-size 8192 --n-gpu-layers 99 --threads 8 `
             --host 127.0.0.1 --port 8000 --no-mmap

# Gemma 4
llama-server --model models\gemma-4-9b-it-q5_k_m.gguf `
             --ctx-size 8192 --n-gpu-layers 99 --threads 8 `
             --host 127.0.0.1 --port 8000 --no-mmap
```

### 2. LiteLLM proxy (port 4000)

**macOS / Linux**
```bash
source .venv/bin/activate
litellm --config config.yaml
```

**Windows (PowerShell)**
```powershell
.\.venv\Scripts\Activate.ps1
$env:PYTHONUTF8 = 1   # LiteLLM's startup banner crashes on a non-UTF-8 console
litellm --config config.yaml
```

#### LiteLLM admin UI database (optional)

You don't need this to run the harness: the [Control UI](control-ui.md#control-ui) covers health, routing and fallbacks. LiteLLM's own admin UI at http://localhost:4000/ui logs in with just `LITELLM_MASTER_KEY`, but its pages (virtual keys, users, spend) show "Not connected to DB" until LiteLLM has a Postgres database. To add one with Docker:

```bash
docker run -d --name litellm-db -e POSTGRES_PASSWORD=litellm -p 5432:5432 postgres:16
```

Then add the connection string to `.env`, install Prisma in the venv, and restart LiteLLM, which creates its tables on startup:

```
DATABASE_URL=postgresql://postgres:litellm@localhost:5432/postgres
```

```bash
pip install prisma
```

### 3. Router (port 6060)

**macOS / Linux**
```bash
source .venv/bin/activate
python router.py
```

**Windows (PowerShell)**
```powershell
.\.venv\Scripts\Activate.ps1
python router.py
```


### 4. Node.js interceptor (port 3000)

```powershell
npm start
```

Point an OpenAI-compatible assistant (Cursor, Aider, Continue, Cline) at `http://localhost:3000/v1`.
