# Run it on a server (Docker)

Run the harness on a free or rented server, keep it private, and choose how it routes with `.env` settings. Back to the [README](../README.md).

## Run it on a server (Docker)

You can run the harness on a rented or free cloud server (a VPS) instead of your PC, so it is always on and you can reach it from any of your devices. The server runs all three parts in Docker containers. Out of the box the local engine and Ollama don't run there, so strong requests use the OpenRouter backups (the same as when your engine is off today); [Choose how it works](#choose-how-it-works) shows how to add local models or pick other models.

**Which server.** The three parts use about 450 MB of memory together with the default Router setting (Jev through OpenRouter). Oracle Cloud's Always Free "Ampere A1" server (up to 4 CPUs and 24 GB) is the roomiest free choice. The 1 GB free servers (Google Cloud e2-micro, AWS, Azure) also fit, but building the images is slow on them and needs swap; see [Google Cloud's free tier instead](#on-google-clouds-free-tier-instead). The RouteLLM BERT Router setting needs about 2 GB more, so use it only on the bigger server (see the last step).

**Keep it private.** With the harness on the internet, anyone who finds its address could use your API credit. The Docker setup won't start without a password (`HARNESS_PASSWORD`), and the steps below reach it through Tailscale, a free private network between your own devices, so the server needs no open ports.

### Steps

1. **Create the server.** In Oracle Cloud: Create instance, image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex** (1 or 2 CPUs and 6 to 12 GB is plenty). Save the SSH key it offers. Leave the network settings as they are; don't open port 3000.
2. **Connect to it** from PowerShell (Windows has `ssh` built in), using the key you saved and the server's public IP:
   ```powershell
   ssh -i C:\path\to\ssh-key.key ubuntu@SERVER_IP
   ```
   Everything below runs in that window, on the server.
3. **Install Docker and Tailscale.** Run these, then follow the link `tailscale up` prints to sign in:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   Type `exit` and connect again (step 2) so the Docker permission applies.
4. **Get the harness and fill in `.env`:**
   ```bash
   git clone https://github.com/skyfly200/custom-ai-harness.git
   cd custom-ai-harness
   cp .env.example .env
   nano .env
   ```
   Fill in your API keys as on your PC, and set `HARNESS_PASSWORD` (a password of your choice) and `LITELLM_MASTER_KEY` (any text starting with `sk-`). Save with Ctrl+O, Enter, then Ctrl+X.
5. **Start it:**
   ```bash
   docker compose up -d --build
   ```
   The first build takes a few minutes. It starts again on its own after a reboot.
6. **Open it from your PC.** Install Tailscale on your PC (and phone, if you like) and sign in with the same account. Then open `http://SERVER_NAME:3000/ui`, where `SERVER_NAME` is the server's name in the Tailscale app. The browser asks for a user name and password: type anything as the user name and your `HARNESS_PASSWORD` as the password.
7. **Point Claude Code at it,** the same as on your PC but with the server's address and your password:
   ```powershell
   $env:ANTHROPIC_BASE_URL = "http://SERVER_NAME:3000"
   $env:ANTHROPIC_AUTH_TOKEN = "your HARNESS_PASSWORD"
   $env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"
   claude
   ```
   Other tools use `http://SERVER_NAME:3000/v1` with the password as their API key.

### On Google Cloud's free tier instead

The same steps work on Google Cloud's free e2-micro server, with these changes:

- **Step 1:** in Compute Engine, create a VM with machine type **e2-micro** in **us-west1, us-central1 or us-east1** (the only free regions), image **Ubuntu 24.04**, and boot disk **Standard persistent disk, 30 GB or less**. Leave "Allow HTTP/HTTPS traffic" unticked.
- **Step 2:** use the **SSH** button next to the VM in the Google Cloud console instead of PowerShell.
- **Before step 5, add swap.** With 1 GB of memory, installing LiteLLM can run out of memory and stop. These lines add 2 GB of swap (disk used as spare memory), and it stays after a reboot:
  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
- **Watch the data allowance.** The free tier includes 1 GB a month of data leaving Google, and every request the harness sends on to OpenRouter counts. Claude Code requests are large (often 100 KB to 1 MB each), so daily use can go over; Google then charges a small amount per GB. Check **Billing** in the console after a week. Oracle's free tier allows 10 TB a month, so it's the better pick for heavy use.

### Looking after it

All of these run on the server, inside the `custom-ai-harness` folder:

| To | Run |
|----|-----|
| See what it's doing | `docker compose logs -f` (Ctrl+C to stop watching) |
| Apply a model or fallback change from the Routing page | `docker compose restart gateway` |
| Update to the latest version | `git pull`, then `docker compose up -d --build` |
| Stop it | `docker compose down` |
| Apply a change to `.env` | `docker compose up -d --build` |

Your settings, usage numbers and `mcp-servers.json` live in the `data` folder. Chat can link repos you clone into the `repos` folder: clone one there and link it in chat as `/repos/NAME`. MCP servers started with `npx` work; ones that need `uvx` or other programs don't, because the container doesn't include them.


### Choose how it works

Lines you add to `.env` decide how the server works. Leave them all out and you get the setup above: Jev through OpenRouter picks between a strong and a cheap model for each request. After changing `.env`, run `docker compose up -d --build`.

**How it decides which model answers** (`HARNESS_MODE`):

| `.env` line | What it does | Memory |
|---|---|---|
| _(none)_ or `HARNESS_MODE=jev` | Jev through OpenRouter judges each request (uses `OPENROUTER_API_KEY`) | about 450 MB |
| `HARNESS_MODE=laya` | Laya judges each request on the server itself, with no outside call. Its model downloads on the first request | 2 GB or more |
| `HARNESS_MODE=routellm` | RouteLLM's BERT model judges each request on the server | 2 GB or more |
| `HARNESS_MODE=llm` | A chat model judges each request (GPT-4o mini through OpenRouter; `ROUTER_MODEL=` picks another) | about 450 MB |
| `HARNESS_MODE=passthrough` | No judging and no prompt changes: every request goes straight to one model, set with `PASSTHROUGH_MODEL=`. Use this to give another app or tool a plain API address | about 450 MB |

**Which models it picks between.** Use any model name from `config.yaml` or the Routing page:

```bash
STRONG_MODEL=fast-openrouter                   # hard requests (default local-engine: your local engine, then backups)
STRONG_MODEL_TOOLS=fallback-openrouter-tools   # hard requests from Claude Code and other tool-using agents (default: STRONG_MODEL)
WEAK_MODEL=fallback-groq                       # easy requests
WEAK_MODEL_TOOLS=fallback-openrouter-tools     # easy requests from tool-using agents
```

`fallback-openrouter-tools` is NVIDIA Nemotron 3.5 Super VL on OpenRouter: free, and it calls tools. Setting both `*_TOOLS` lines to it sends every Claude Code and agent request to a free model.

**A plain API address for another app** (passthrough):

```bash
HARNESS_MODE=passthrough
PASSTHROUGH_MODEL=fast-openrouter                        # a name from config.yaml, or a provider's own id:
# PASSTHROUGH_MODEL=openrouter/anthropic/claude-sonnet-5.5
# PASSTHROUGH_MODEL=openai/my-model                      # any OpenAI-style server, with:
# PASSTHROUGH_API_BASE=http://my-server:8000/v1
# PASSTHROUGH_API_KEY=its-key
```

The app then uses `http://SERVER_NAME:3000/v1` (OpenAI style) or `http://SERVER_NAME:3000` (Anthropic style) with your `HARNESS_PASSWORD` as its API key. Whatever model name the app asks for, the answer comes from `PASSTHROUGH_MODEL`.

**Local models with Ollama.** These run on the server's own processor, so they need a big server: 8 GB of memory or more for a 7B model, and they are slow without a graphics card.

```bash
COMPOSE_PROFILES=local
LOCAL_MODELS=qwen2.5-coder:7b gemma3:4b   # downloaded from ollama.com on first start
WEAK_MODEL_TOOLS=local-qwen2.5-coder:7b   # optional: send easy requests to one of them
```

Each model shows up as `local-NAME` for the settings above and in the chat page's model list. `fallback-ollama` in `config.yaml` uses the same Ollama. `docker compose logs -f ollama` shows the downloads.

**Your own local engine.** A llama.cpp or vLLM server on the same machine (`launch-local.sh`, changed to listen on `0.0.0.0` instead of `127.0.0.1`) is used as the strong model automatically. Another address goes in `LOCAL_ENGINE_URL=http://ADDRESS:8000`.

Settings in `.env` win over the Settings and Routing pages each time the server starts. Leave a setting out of `.env` to manage it from the Settings page instead.
