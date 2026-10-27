# Claude Code and agent tools

Use Claude Code through the harness, check its commands with Jev, and let agents ask Jev about files. Back to the [README](../README.md).

## Draft an orchestration plan

In Claude Code, run `/wayfinder <goal>` to map a goal into project destinations, unresolved domain questions, and a dependency-ordered JSON ticket draft. Wayfinder is planning-only: it does not edit the repository or create GitHub issues, and every drafted ticket remains not Ready until a person reviews and enters it in the tracker.

## Using Claude Code through the harness

`npm run claude` from the repo folder sets this up and starts Claude Code in one step; this is what it sets:

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "local-harness"   # dummy; keeps your real Anthropic credentials off the local stack
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"       # auto mode: skip server-side checks the harness can't carry
claude
```

The Interceptor routes each request and the Gateway translates the Anthropic Messages format for whichever model serves it, including tool use and streaming. The Interceptor log shows each routing decision.

**Auto mode.** Claude Code's auto mode asks Anthropic's server to run its safety checks inside each request, but the harness rewrites requests and sends them to non-Anthropic models, so those checks never reach the session. `CLAUDE_CODE_AUTO_MODE_SERVER=0` tells Claude Code to use its own classifier requests from the start instead of stopping at the first checked action with an "isn't eligible" notice. Those classifier requests also go through the Interceptor and are routed like any other request, so the Gateway model that serves them judges whether an action is safe. See [Auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing).

## Command guard (Jev checks commands before they run)

The harness can check each shell command and file write an agent is about to run. `.claude/hooks/guard.js` is a Claude Code `PreToolUse` hook that sends the command to `POST /v1/guard` and passes the answer back:

- **Rules first.** `guard-rules.json` lists patterns that block a command (`rm -rf /`, a force push to `main`, writing to a disk, sending `.env` to the internet, editing `.git/` or SSH keys) or make the agent ask you first (any recursive delete, other force pushes, `git reset --hard`, `curl … | sh`, overwriting `.env`, `DROP TABLE`). No model is called for these. To change them, copy the file to `guard-rules.local.json` (gitignored), edit it, then reload with `POST /ui/api/guard/reload` or restart the Interceptor.
- **Read-only commands pass.** `ls`, `cat`, `git status`, `git diff` and the like skip the check, unless something is redirected into a file.
- **Jev for the rest.** Other commands go to the Router's `POST /ask`, which asks Jev (the `systemone` or `laya` backend) two yes/no questions: is it destructive or hard to undo, and does it send secrets out. At 50% or more the agent has to ask you. Jev never blocks on its own unless you set **Guard: block from** on the Settings page. If Jev can't be reached the command goes ahead and your normal Claude Code permissions still apply.
- **"Allow" never approves.** The hook stays silent then, so your usual permission settings decide.

Every decision shows in the Dashboard's **Command guard** table. To turn the hook on for every project, add this to `~/.claude/settings.json` (use the full path to your copy of the repo; on Windows write it with forward slashes):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node C:/path/to/custom-ai-harness/.claude/hooks/guard.js" }] }
    ]
  }
}
```

`HARNESS_GUARD_URL` points the hook at another harness (default `http://localhost:3000/v1/guard`), and `HARNESS_PASSWORD` is sent when set. If the harness isn't running the hook lets commands through; set `HARNESS_GUARD_STRICT=1` to have Claude Code ask you instead. Other agents can call the endpoint directly:

```bash
curl -s localhost:3000/v1/guard -H 'content-type: application/json' -d '{"tool":"Bash","command":"git push --force origin main"}'
# {"decision":"deny","reason":"Force push to a protected branch","rule":"force-push-main",...}
```

## Ask Jev about a file (`ask_jev_file` tools)

Agents often open a big file just to learn one fact about it. `scripts/jev-files-mcp.js` is an MCP server that lets them ask Jev instead: it reads the file on your machine, has Jev answer, and returns one line, so the file never enters the agent's context.

| Tool | Use it for | Answer |
|---|---|---|
| `ask_jev_filebool` | "Does this file read environment variables?" | `yes` or `no`, Jev's confidence, roughly which line |
| `ask_jev_filescale` | "This code is hard to follow" (a statement to rate) | a number from 0 to 1 |
| `ask_jev_files` | the same yes/no question about up to 20 files | only the files that say yes, strongest first |

Add it to Claude Code (use the full path to your copy of the repo):

```bash
claude mcp add jev-files -- node /path/to/custom-ai-harness/scripts/jev-files-mcp.js
```

The chat page can use it too: copy `mcp-servers.example.json` to `mcp-servers.json`; its `jev-files` entry is already on.

How it behaves:

- **It needs the Router on `systemone` (Jev) or `laya`.** Other backends can't answer questions and the tools return an error.
- **Long files are read in parts.** Jev reads as much at once as the Router's `max_chars` setting (2,000 characters by default), so a file is cut into parts of that size, each part is asked the same question, and the strongest answer wins, so one hit anywhere counts. At most 12 parts are read; the reply says when a file was only partly read. Raise `max_chars` on the Settings page if your Jev takes more.
- **Only some files can be sent.** The tool server reads files only inside the folder it was started in, or the folders in `HARNESS_FILE_ROOTS` (separated by `:`, or `;` on Windows). It refuses `.env` and other secrets files, SSH keys, binaries and files over `HARNESS_FILE_MAX_BYTES` (2 MB), because the text goes to Jev's host.
- **It costs one Jev call per part.** Nothing is cached yet.
- `HARNESS_URL` (default `http://localhost:3000`) and `HARNESS_PASSWORD` tell the tool server where the harness is. Other programs can call `POST /v1/jev/ask` directly with `{"text", "question", "mode": "bool" | "scale"}`.
