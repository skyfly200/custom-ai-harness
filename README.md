# Custom AI Coding Harness

A high-performance, cost-optimized proxy and routing harness designed to sit between your coding agent (such as Claude Code or Cursor) and local/cloud LLM endpoints. 

This repository implements a three-pillar efficiency stack:
1. **Intelligent Complexity Routing (RouteLLM):** Automatically classifies incoming prompt complexity, diverting simple scaffolding tasks to free models while reserving heavy models for complex architecture.
2. **Output Compression (Caveman):** Injects specialized system instructions to eliminate preambles, conversational filler, and redundant code duplication, reducing output token consumption by ~65%.
3. **Multi-Model Fallback & Free-Tier Pooling:** Integrates with LiteLLM and local CLI wrappers to pool free providers (Groq, Gemini, OpenRouter) and bypass per-token billing.

---

## Architecture Overview

```
[ Coding Agent / Cursor ] 
        │
        ▼ (Port 3000: Node.js Interceptor + Caveman Prompt)
[ RouteLLM Server ] ──(Complex)──► [ Claude Code CLI Wrapper ] (Pro OAuth)
        │
        └──(Simple)──► [ LiteLLM Fallback Proxy ] ──► [ Groq / Gemini Free Tier ]
```

---

## Prerequisites & Installation

### 1. Initialize the Repository
```bash
git clone https://github.com/your-username/custom-ai-harness.git
cd custom-ai-harness
python -m venv .venv
npm init -y
```

### 2. Install Dependencies
* **Node.js Interceptor Dependencies:**
  ```bash
  npm install express http-proxy-middleware
  ```
* **Python Environment & Routers:**
  ```bash
  # Activate virtual environment on Windows
  .\.venv\Scripts\activate
  
  # Install LiteLLM and RouteLLM
  pip install "litellm[proxy]" routellm
  ```

---

## Configuration & Setup

### Step 1: Set Up Environment Variables
Export your free-tier provider API keys in your active terminal session:

```cmd
set ANTHROPIC_API_KEY=your_anthropic_key
set GROQ_API_KEY=your_groq_key
set GEMINI_API_KEY=your_gemini_key
set OPENROUTER_API_KEY=your_openrouter_key
```

### Step 2: Configure LiteLLM (`config.yaml`)
Create or verify your `config.yaml` file in the root directory to define your fallback tiers.

### Step 3: Run the Services
To spin up your local harness, run the services across your terminal sessions:

1. **Launch RouteLLM Classifier:**
   ```cmd
   .\.venv\Scripts\python -m routellm.openai_server --routers mf --port 6060
   ```
2. **Launch Node.js Interceptor:**
   ```cmd
   node server.js
   ```

---

## Usage

Point your coding assistant or custom development environment to your local proxy endpoint:
* **Base URL:** `http://localhost:3000/v1`

The harness will automatically append the Caveman system instructions, evaluate prompt complexity via RouteLLM, and seamlessly balance traffic between your paid subscription wrappers and free-tier fallback models.

## License
MIT License