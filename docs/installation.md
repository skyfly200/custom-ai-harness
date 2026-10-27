# Installation

Prerequisites and install steps for macOS, Linux and Windows. Back to the [README](../README.md).

## Prerequisites

- **Node.js** 18+
- **Python** 3.10+
- **llama.cpp** or **vLLM** (optional — only needed for a local Tier 1 engine)


## Installation

### macOS / Linux

```bash
git clone https://github.com/skyfly200/custom-ai-harness.git
cd custom-ai-harness

# Node dependencies
npm install

# Python virtual environment
python -m venv .venv
source .venv/bin/activate
pip install "litellm[proxy]" routellm

# Environment variables
cp .env.example .env
# edit .env and fill in your API keys
```

### Windows (PowerShell)

```powershell
git clone https://github.com/skyfly200/custom-ai-harness.git
cd custom-ai-harness

# Node dependencies
npm install

# Python virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install "litellm[proxy]" routellm

# Environment variables
Copy-Item .env.example .env
# edit .env and fill in your API keys
notepad .env
```

> **PowerShell execution policy** — if `Activate.ps1` is blocked, run:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
