# Claude Code headless (`claude -p`) vs Claude Agent SDK (TS) for the Orchestrator

Research for issue #5 (map #3). Question: for a TypeScript Orchestrator that drives frontier steps (Audit of Worker PRs, Escalation) directly, bypassing the LiteLLM Model Layer, what do `claude -p` and the Agent SDK offer, and what are the auth options and usage terms for automated/unattended use?

Sources are official Anthropic docs and published terms only, fetched 2026-09-24. Docs cite Claude Code versions up to ~v2.1.277; several features below are version-gated (noted inline). Quotes are verbatim.

## TL;DR

- **Same engine, two front doors.** The Agent SDK is "A library that runs the Claude Code binary" ([overview](https://code.claude.com/docs/en/agent-sdk/overview)); `claude -p` is "using the Agent SDK via the CLI" ([headless](https://code.claude.com/docs/en/headless)). Capabilities largely match; the TS SDK adds typed messages, a `canUseTool` callback, runtime `setPermissionMode()`, hooks as code, `sessionStore`, and session list/read helpers. `npm install @anthropic-ai/claude-agent-sdk` bundles the native binary.
- **Everything the Orchestrator needs exists in both:** resumable sessions by ID (plus fork, custom session ID, no-persist), JSON Schema–validated structured output, six permission modes plus allow/deny rules and an explicit "no human available" switch, git-worktree isolation, programmatic subagents with depth/concurrency/spend caps, and per-run cost/usage on the final result message.
- **Cost figures are estimates.** `total_cost_usd`/`modelUsage` are "client-side estimates, not authoritative billing data" ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).
- **Auth/terms:** API key (Console) or cloud provider credentials are the unambiguous path for automated use. Subscription OAuth (incl. `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) is documented "For CI pipelines, scripts", but the legal page scopes OAuth to "ordinary use of Claude Code and other native Anthropic applications", says Pro/Max limits "assume ordinary, individual usage", and the Agent SDK docs tell developers to use API keys. Details and quotes in [Auth and usage terms](#auth-and-usage-terms).

## Capability comparison

| Need | `claude -p` (CLI) | Agent SDK (TS) `query({ prompt, options })` |
|---|---|---|
| Start / one-shot | `claude -p "<prompt>"`; exit 0 on success, non-zero on failure | `for await (const m of query(...))`; single-shot `query()` throws after yielding an error result |
| Resume specific session | `--resume <id>` (or path to `.jsonl`) | `resume: sessionId` |
| Continue most recent | `--continue` | `continue: true` |
| Fork | `--fork-session` | `forkSession: true` |
| Choose session ID | `--session-id <uuid>` | `sessionId` |
| Don't persist | `--no-session-persistence` | `persistSession: false` |
| Cross-host resume | move the `.jsonl` | `sessionStore` adapter, or move the `.jsonl` |
| JSON envelope | `--output-format json` / `stream-json` | typed `SDKMessage` stream |
| Schema-validated output | `--json-schema '<schema>'` → `structured_output` | `outputFormat: { type: 'json_schema', schema }` → `structured_output` |
| Permission mode | `--permission-mode <mode>` | `permissionMode`; `setPermissionMode()` mid-session |
| Allow / deny rules | `--allowedTools`, `--disallowedTools`, `--tools` | `allowedTools`, `disallowedTools` |
| Programmatic approval | `--permission-prompt-tool <mcp tool>` | `canUseTool` callback, hooks |
| No human available | `--permission-prompts none` | `permissionPrompts: 'none'` |
| Worktree | `--worktree/-w [name]` (works with `-p`) | set `cwd` to a worktree; `projectConfigRoot` for config |
| Subagents | `--agents '<json>'`, `--agent` | `agents: Record<string, AgentDefinition>` |
| Turn / spend caps | `--max-turns`, `--max-budget-usd` | `maxTurns`, `maxBudgetUsd` |
| Cost / usage | `total_cost_usd` + per-model breakdown in JSON result | `total_cost_usd`, `usage`, `modelUsage` on `SDKResultMessage` |
| Reproducible startup | `--bare` (skips hooks, skills, plugins, MCP, CLAUDE.md) | `settingSources: []` etc. |

### Session control and resume

- CLI: "Use `--continue` to continue the most recent conversation, or `--resume` with a session ID to continue a specific conversation." Capture the ID with `claude -p "Start a review" --output-format json | jq -r '.session_id'`. "Claude Code finds the session by its ID in any project on this machine" (before v2.1.223, same directory only). `--resume` also accepts "the absolute path to a session's `.jsonl` transcript file." ([headless](https://code.claude.com/docs/en/headless))
- Note: plain `--continue` "Skips sessions created with `claude -p` or the Agent SDK", but "`claude -p --continue` includes `-p`, SDK, and `/loop` sessions." `--session-id`: "Use a specific session ID for the conversation (must be a valid UUID)." `--no-session-persistence`: "sessions are not saved to disk and cannot be resumed. Print mode only." ([CLI reference](https://code.claude.com/docs/en/cli-reference))
- SDK: session ID is on every result message ("present on every result regardless of success or error") and, in TS, on the init system message. Options: `continue`, `resume`, `forkSession`, `sessionId` ("Use a specific UUID for the session instead of auto-generating one"), `persistSession: false` (TS only). "Sessions persist the **conversation**, not the filesystem." Sessions are stored at `~/.claude/projects/<encoded-cwd>/*.jsonl`; resume is "Same machine only" unless you use a `sessionStore` adapter or copy the file. TS helpers: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()`. The V2 `createSession()` API "was removed in TypeScript Agent SDK 0.3.142." ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript))
- Useful for Escalation: resume after a limit. "The first run ended with `error_max_turns` or `error_max_budget_usd` ... resume with a higher limit." ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions))
- Anthropic's own advice for ephemeral hosts: "Capture the results you need ... as application state and pass them into a fresh session's prompt. This is often more robust than shipping transcript files around." ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions))
- SIGTERM on `claude -p` exits 143 and leaves the turn unfinished; "To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`." ([headless](https://code.claude.com/docs/en/headless))

### Structured / JSON output

- CLI `--output-format`: `text` (default), `json` ("structured JSON with result, session ID, and metadata"), `stream-json` ("newline-delimited JSON for real-time streaming"). "To get output conforming to a specific schema, use `--output-format json` with `--json-schema` ... with the structured output in the `structured_output` field." An invalid schema now fails fast (`Error: --json-schema is not a valid JSON Schema`); "Before v2.1.205, Claude Code silently ignored an invalid schema." `format` is annotation-only. ([headless](https://code.claude.com/docs/en/headless))
- SDK: `outputFormat: { type: "json_schema", schema }`. "the SDK validates the output against it, re-prompting on mismatch." "The SDK validates schemas with JSON Schema draft-07 ... Zod targets draft 2020-12 by default, so pass `target: "draft-7"`." Failure subtype `error_max_structured_output_retries`. Also: "A result can also end with subtype `success` but no `structured_output` value ... Treat that case as a failure as well." ([structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs))
- Streaming: `stream-json` + `--verbose` + `--include-partial-messages`; subagent messages carry `parent_tool_use_id`; `system/api_retry` events expose retry attempts and error category (`rate_limit`, `billing_error`, `authentication_failed`, ...); `system/init` reports model, tools, MCP servers, plugins, and `mcp_server_errors`/`plugin_errors` for CI gating. ([headless](https://code.claude.com/docs/en/headless))

### Permission modes

- Modes (CLI `--permission-mode`): "`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, or `manual` as an alias for `default`." "For `-p`, that's `default` when nothing is configured." `--dangerously-skip-permissions` is "Equivalent to `--permission-mode bypassPermissions`." ([CLI reference](https://code.claude.com/docs/en/cli-reference))
- SDK evaluation order: hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`. Deny rules apply "even in `bypassPermissions` mode". ([SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions))
- For a locked-down headless reviewer: "pair `allowedTools` with `permissionMode: "dontAsk"`" — "Listed tools are approved ... and every other call that would prompt is denied instead." Use when "you want a fixed, explicit tool surface for a headless agent." ([SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions))
- Gotcha: "**`allowed_tools` does not constrain `bypassPermissions`.** ... Setting `allowed_tools=["Read"]` alongside `permission_mode="bypassPermissions"` still approves every tool". TS requires `allowDangerouslySkipPermissions: true` for `bypassPermissions`. ([SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript))
- Unattended switch: "Pass `--permission-prompts none` when nobody is available to answer permission prompts, for example in a scheduled job." Denials appear as `permission_denied` messages and in `permission_denials` on the result. Requires v2.1.259+. TS equivalent `permissionPrompts: 'none'`. ([headless](https://code.claude.com/docs/en/headless))
- `auto` (classifier approves/denies): available on "All plans"; on the Anthropic API it needs "Claude Opus 4.6 or later, Sonnet 4.6 or later, or a Fable model"; "Auto mode reduces permission prompts but does not guarantee safety." ([permission modes](https://code.claude.com/docs/en/permission-modes))
- Subagents inherit the parent's mode; "Claude Code never applies a `"bypassPermissions"` value" from an `AgentDefinition`. ([SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions))
- Security note for PR audits: "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted." "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." Relevant when auditing untrusted Worker PR checkouts. ([headless](https://code.claude.com/docs/en/headless))

### Worktrees

- `--worktree`/`-w`: "Start Claude in an isolated git worktree at `<repo>/.claude/worktrees/<name>`", on branch `worktree-<name>`. Accepts `#<number>` or a PR URL to "fetch that PR or MR from `origin` and branch the worktree from it" — directly useful for auditing a Worker PR. ([CLI reference](https://code.claude.com/docs/en/cli-reference), [worktrees](https://code.claude.com/docs/en/worktrees))
- Headless specifics: "Non-interactive runs with `-p` skip the trust check, so `claude -p --worktree` proceeds without it." "Non-interactive runs with `-p` have no exit prompt, so Claude doesn't clean up their worktrees" — the Orchestrator must `git worktree unlock` / `git worktree remove` itself. Resume (`-p --resume` and SDK) returns the session to its worktree; on refusal `-p` stops with a stderr error and a `result` with `startup_failure_reason` `worktree_unverified` / `worktree_resume_refused` (v2.1.274+). ([worktrees](https://code.claude.com/docs/en/worktrees))
- Base branch: default `"fresh"` (remote default branch); `worktree.baseRef: "head"` to branch from local HEAD. Isolation checks block edits/commands/git redirects that target the main checkout. `.worktreeinclude` copies gitignored files like `.env`. ([worktrees](https://code.claude.com/docs/en/worktrees))
- Subagents: `isolation: worktree` in agent frontmatter gives each subagent a temporary worktree, removed if unchanged. ([worktrees](https://code.claude.com/docs/en/worktrees))
- SDK: no `worktree` option in `Options`; point `cwd` at a worktree you created. `projectConfigRoot`: "Absolute path of the trusted checkout that `cwd` is a worktree of. Claude Code reads project settings, `.mcp.json`, and the project's `.claude/` ... from this directory instead of `cwd`" (v2.1.275+). ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript))

### Subagents

- Defined via `agents` option (SDK) or `--agents '<json>'` (CLI), or `.claude/agents/*.md`. `AgentDefinition` fields: `description`, `prompt` (required); `tools`, `disallowedTools`, `model` (`'opus'`, `'sonnet'`, `'haiku'`, `'fable'`, `'inherit'`, or full ID), `skills`, `memory`, `mcpServers`, `maxTurns`, `background`, `omitClaudeMd`, `effort`, `permissionMode`. Invoked through the `Agent` tool. ([SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents))
- Isolation: "only its final message returns to the parent." "Subagents run in the background by default."
- Caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default `3`), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default `20`), `maxBudgetUsd` (counts subagent spend). "Claude Opus 5 delegates to subagents more readily than earlier models, so the depth, concurrency, and spend limits matter most on queries that run Opus 5." TS `env` option "replaces the subprocess environment with it, so spread `process.env`". ([SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents))
- Resumable via `agentId` in the Agent tool result plus `resume: sessionId`. For larger fan-out there is a `Workflow` tool (TS SDK v0.3.149+). ([SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents))

### Per-run cost and usage reporting

- CLI: "With `--output-format json`, the response payload includes `total_cost_usd` and a per-model cost breakdown ... When you continue an earlier conversation with `--continue` or `--resume`, the run reports the conversation's whole total, earlier runs' spend included. Both figures are client-side estimates." ([headless](https://code.claude.com/docs/en/headless))
- SDK `SDKResultMessage` (both success and error arms) carries `session_id`, `duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `stop_reason`; success adds `result`, `structured_output`; errors add `errors`, `startup_failure_reason`. Error subtypes: `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`. ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript))
- Which field to trust: `usage` "Excluded" subagent activity; `total_cost_usd` and `modelUsage` "Included". "Use `modelUsage` ... for whole-tree token accounting." Per-step `output_tokens` "is a placeholder" — read output tokens from the result. Resumed sessions: "Read the latest result for the session total; summing results double-counts the restored spend" (behavior since v2.1.277). A crash can yield a result with zeroed totals. ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking))
- Accuracy: "The `total_cost_usd` and `costUSD` fields are client-side estimates, not authoritative billing data ... For authoritative billing, use the Usage and Cost API or the Usage page in the Claude Console. Do not bill end users or trigger financial decisions from these fields." ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking))
- `--max-budget-usd` / `maxBudgetUsd`: "Maximum dollar amount to spend on API calls before stopping (print mode only). Spend from subagents counts toward the cap." Restored totals from resumed runs don't count toward it. ([CLI reference](https://code.claude.com/docs/en/cli-reference))

## Auth and usage terms

### Auth mechanisms (technical)

Precedence, highest first ([authentication](https://code.claude.com/docs/en/authentication)):

1. Cloud provider (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN` (bearer; "Use this when routing through an LLM gateway or proxy")
3. `ANTHROPIC_API_KEY` — "In non-interactive mode (`-p`), the key is always used when present."
4. `apiKeyHelper` script
5. `CLAUDE_CODE_OAUTH_TOKEN` — "A long-lived OAuth token generated by `claude setup-token`. Use this for CI pipelines and scripts where browser login isn't available."
6. Anthropic profile / Workload Identity Federation
7. Subscription OAuth from `/login`

"`apiKeyHelper`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` apply to the CLI and the surfaces that wrap it, including ... the Agent SDK." ([authentication](https://code.claude.com/docs/en/authentication))

`claude setup-token`: "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token ... This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make model requests". "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`." ([authentication](https://code.claude.com/docs/en/authentication))

`--bare`: "Claude Code never reads OAuth credentials or the system keychain. For the Anthropic API, set `ANTHROPIC_API_KEY` ... or supply an `apiKeyHelper`." ([headless](https://code.claude.com/docs/en/headless))

Unattended-login risk: a `/login` credential expires; "Renewing early matters most for sessions that run unattended." ([authentication](https://code.claude.com/docs/en/authentication))

Repo-specific: since `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` outrank OAuth and `-p` always uses a present key, the Orchestrator must control the child's environment explicitly. Otherwise, env vars set for the LiteLLM Model Layer (e.g. `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) could route or authenticate the "direct" frontier calls. The TS SDK's `env` option replaces the subprocess environment.

### Which terms apply

- "Your use of Claude Code is subject to: Commercial Terms of Service — for Team, Enterprise, and Claude API users; Consumer Terms of Service — for Free, Pro, and Max users." ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance))
- "Use of the Claude Agent SDK is governed by [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), including when you use it to power products and services that you make available to your own customers and end users". ([SDK overview](https://code.claude.com/docs/en/agent-sdk/overview))
- "Claude Code usage is subject to the [Anthropic Usage Policy](https://www.anthropic.com/legal/aup). Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance))

### Credential-use terms (verbatim)

From [Claude Code legal and compliance → Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use):

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials — for example, configuring an API key in a development environment, secrets manager, or machine image for use by the customer's own authorized users — provided the resulting usage is billed to the key owner under their agreement with Anthropic (or the applicable provider) and is not resold or intermediated as described above. Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

From the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart):

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

From the [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) (effective October 8, 2025), §3, listing things users may not do:

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

§2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else."

On embedding Claude Code in a product ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)): requires the Commercial Terms, "The Claude Code binary must not be modified", and "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".

### What this means for the Orchestrator

This is an engineering reading, not legal advice. Where the sources leave a gap, it is flagged.

| Setup | Status per sources |
|---|---|
| Orchestrator (SDK or `claude -p`) with **Console API key** or Bedrock/Vertex/Foundry creds, billed to the owner | Clearly permitted. It is the documented auth for the Agent SDK and for `--bare`, and is carved out of Consumer Terms §3 ("via an Anthropic API Key"). Governed by the Commercial Terms. |
| Owner's own `claude -p` (unmodified binary) with **own Pro/Max subscription**, via `/login` or `setup-token`, for personal automation on own machine | **Grey area.** Anthropic's docs present `setup-token` "For CI pipelines, scripts", which is arguably the "explicitly permit it" exception in Consumer Terms §3. But OAuth is "designed to support ordinary use of Claude Code", and Pro/Max limits "assume ordinary, individual usage". No source says outright that an always-on, unattended orchestrator loop on a subscription is allowed. |
| **Agent SDK** app on a subscription token | Disfavored. SDK docs say "Use the API key authentication methods ... instead", and developers "should use API key authentication". The auth docs do list "the Agent SDK" among login paths, so it can work technically, but the policy text points to API keys. |
| Orchestrator used by **other people** through the owner's subscription, or offering claude.ai login | Not permitted: "route requests through Free, Pro, or Max plan credentials on behalf of their users"; "does not allow third party developers to offer claude.ai login". |

Practical implications:

- If the Orchestrator should be an unattended service, use an API key (or cloud provider) and add `--bare` / `settingSources: []` for reproducibility and safety. Budget with `maxBudgetUsd`, and reconcile against the Console Usage and Cost API, not `total_cost_usd`.
- If the owner wants subscription-based usage for cost reasons, the most defensible form is invoking the **unmodified `claude` binary** under the owner's own login, for the owner's own work, at "ordinary, individual" volumes. Note that `--bare` is then unavailable (it ignores OAuth). For certainty, the docs say: "For questions about permitted authentication methods for your use case, please contact sales."

## Open points / not verified

- No source gives numeric subscription rate limits for `-p`/SDK use; the only statement found is the "ordinary, individual usage" assumption.
- The full [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [Usage Policy](https://www.anthropic.com/legal/aup) were not read clause by clause; nothing in the Claude Code docs pointed to a specific automation clause there.
- Version gates: many behaviors cited need Claude Code v2.1.2xx. Pin the SDK/CLI version in the Orchestrator and gate on the `capabilities` array in `system/init` rather than version strings, as [headless](https://code.claude.com/docs/en/headless) recommends.

## Sources

- Run Claude Code programmatically (headless): https://code.claude.com/docs/en/headless
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK quickstart: https://code.claude.com/docs/en/agent-sdk/quickstart
- Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Agent SDK structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Permission modes: https://code.claude.com/docs/en/permission-modes
- Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Agent SDK cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Worktrees: https://code.claude.com/docs/en/worktrees
- Authentication: https://code.claude.com/docs/en/authentication
- Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Consumer Terms of Service: https://www.anthropic.com/legal/consumer-terms
- Commercial Terms of Service: https://www.anthropic.com/legal/commercial-terms
