# App launcher: plan

Status: plan only. Nothing is built, created or deployed. Written Nov 25, 2026.

Goal (Skyler): a new app must not need a new round of platform setup. One command makes the GitHub repo, the Neon database and the Vercel or Fly project, links them, and fills in shared starter keys. Experiments use the shared keys. A project gets its own keys when it is mature.

## Recommendation

- Build the launcher inside the harness. Do not make a new repo.
- Serve it from the Interceptor (`server.js`) as the harness's first MCP server, at `/mcp/launcher`. Extra cost: $0.
- Extend the Apps page code that exists (`runner/runs.js` `newApp`, `runner/github.js`, `runner/hosting.js`). Today it makes the repo and writes a DEPLOY.md with manual steps. The launcher does those steps through the Neon, Vercel and Fly APIs.
- Keep the MCP gateway small and public. Its pass-through hub connects to the harness's MCP servers with one scoped key. Muse, Claude Duet and the harness assistant then reach everything through one gateway address.
- Default host: Vercel builds from the repo through its own Git link. Do not use GitHub Actions for builds (the Actions minutes ran out on Nov 24).

## What the harness has now

| Part | Where | What it does |
| --- | --- | --- |
| GitHub | `utils/githubOAuth.js`, `utils/userGithub.js`, `runner/github.js` | Person's token or GitHub App. `createRepo` makes a private repo. Clone, push, open PR. |
| Apps page | `runner/runs.js` `newApp`, `runner/templates.js`, `templates/web-app` | Fills a template, makes or links a repo, registers the app, runs the first build. |
| Hosting files | `runner/hosting.js` | Writes CI and deploy workflows for Vercel, Netlify or Fly, and Neon or Supabase settings. Holds no credential. DEPLOY.md lists the secrets to paste by hand. |
| Vercel | `utils/mcpCatalog.js` (`VERCEL_TOKEN`, `askBefore: 'writes'`) | Vercel's remote MCP server as a chat tool. Not used by the Apps page. |
| Fly | `fly.toml`, `runner/sprites.js`, `runner/flyMachines.js` | The harness runs on Fly (`skyler-agents`). Sprites sandboxes with `SPRITES_TOKEN`. |
| Neon | `neon.ts`, `utils/db.js`, `migrations/` | The harness's own database and Neon Auth sign-in. No Neon API key for making new projects. |
| OpenRouter | `utils/openrouterKeys.js`, `utils/mainKey.js` | With `OPENROUTER_MANAGEMENT_KEY` it makes capped keys ($5, 30 days by default) and renews them. |
| Secrets at rest | `utils/secrets.js` | AES-256-GCM with `ENCRYPTION_KEY`. Refuses to store a secret if the key is not set. |
| Server secrets | Fly secrets (`fly secrets set`) | `DATABASE_URL`, `OPENROUTER_API_KEY`, `LITELLM_MASTER_KEY` and others. Never in the repo. |
| MCP | `utils/mcp.js`, `utils/userMcp.js` | The harness is an MCP client only. Per-person remote servers in `user_mcp`, encrypted. `askBefore` makes a tool wait for Allow. |
| API keys | `utils/users.js`, `utils/runKeys.js` | User API keys (full access). Run keys: capped, path-limited, in memory only. |

Gaps: no MCP server endpoint, no Neon API key, no Fly API token for new apps, no store for shared app keys, and no code that sets env vars on a new Vercel or Fly project.

## Launcher tools

All tools have the prefix `launcher_`. "Confirm" means the tool needs `confirm: true` and a `plan_id` from `launcher_plan_app` that is less than 10 minutes old. This makes the agent show the plan to Skyler before it creates anything.

| Tool | Does | Confirm | Cost |
| --- | --- | --- | --- |
| `launcher_list_templates` | Lists templates and hosts. | No | $0 |
| `launcher_list_apps` | Lists launched apps, their repo, database, host and key mode (shared or own). | No | $0 |
| `launcher_check_name` | Checks that the name is free on GitHub, Neon and Vercel or Fly. | No | $0 |
| `launcher_plan_app` | Dry run. Shows each resource it will make, each key it will attach, the monthly cost and the free-tier counts. Returns a `plan_id`. | No | $0 |
| `launcher_create_app` | Runs a plan: repo from template, Neon project, Vercel or Fly project linked to the repo, env vars set, first build started. | Yes | $0 on Vercel. About $2 a month on Fly if a machine stays on. |
| `launcher_create_repo`, `launcher_create_database`, `launcher_create_host` | Single steps, for a repo that exists. Each needs its own plan. | Yes | Same as above |
| `launcher_attach_key` | Puts a shared key on an app's host env vars. | Yes | $0 |
| `launcher_rotate_key` | Pushes a new value of a shared key to every app that uses it. | Yes | $0 (one rebuild per app) |
| `launcher_graduate_app` | Replaces an app's shared keys with its own keys. | Yes | $0 to make keys. Spend moves to the app's own cap. |
| `launcher_app_status` | Last build, last deploy, database size, keys in use. | No | $0 |

Not MCP tools, on purpose:

- Delete an app, its repo, its database or its host. Do this on the harness Apps page only, with a typed name.
- Add a shared key value. Paste values on a harness page only, so a key never goes through a model or a chat log.
- Buy a domain, change a plan or add a payment method. The launcher never does these.

## Where keys live

Two kinds of key. Keep them apart.

1. Owner tokens. These make resources. They never go to an app.
   - `NEON_API_KEY` (new), `VERCEL_TOKEN` (exists in the catalog), `FLY_API_TOKEN` (new, an org token), the person's GitHub token (exists).
   - Store: Fly secrets on the harness app, the same as `OPENROUTER_API_KEY` now.
2. Starter keys. These go into apps.
   - Examples: OpenRouter, Groq, Brave Search, Wolfram.
   - Store: a new Neon table `launcher_keys` in the harness database. Each value is encrypted with `utils/secrets.js`.
   - Columns: name, value (encrypted), provider, mode (`shared` or `minted`), spend cap, created, rotate by.
   - A second table `launcher_key_uses` links each key to each app and env var name. Rotation reads this table.

Scope rules:

- Each experiment gets the shared starter keys by default.
- Where the provider can make keys, the launcher makes one per app (minted). OpenRouter can do this now: one key per app, $2 cap, 30 days, renewed by the code that exists. This costs $0 and limits a leak to one app. Use minted keys in place of the shared OpenRouter key.
- Set a spend cap at the provider for each shared key where the provider allows it. A shared key is only for low-limit accounts.
- Owner tokens never go into `launcher_keys` and never go into an app.
- The gateway never receives a starter key or an owner token.

Rotation:

- Shared keys: rotate every 90 days, or at once after a leak. Skyler pastes the new value on the harness page. `launcher_rotate_key` pushes it to each linked app and starts one rebuild per app. Then Skyler deletes the old key at the provider.
- Minted keys: the harness renews them before they expire (30 days).
- Owner tokens: rotate with `fly secrets set`. Vercel and Fly tokens can have an expiry. Set 90 days.
- `launcher_list_apps` shows the age of each key, so an old key is easy to see.

Graduation:

- `launcher_graduate_app` makes app-own keys where the provider can (OpenRouter). For other providers, it lists the keys that Skyler must make, and replaces each one when Skyler pastes it.
- If an app becomes commercial, it must leave Vercel Hobby (Vercel's terms). Move it to Netlify, as for other commercial work, or to Vercel Pro ($20 a month). This is Skyler's decision. The launcher does not do it.

## Hosting

| Choice | Monthly cost | Result |
| --- | --- | --- |
| Inside the Interceptor on the harness Fly Machine | $0 extra | Pick this. The owner tokens are already there. The Machine costs about $11 a month while it runs and sleeps after 5 idle minutes (docs/fly.md). |
| A Vercel function in the gateway | $0 | Do not use. It puts owner tokens on a public repo's host and splits keys between two places. |
| A separate Fly app | About $2 to $4 | Do not use. More cost and one more place for keys. |

Each launched app:

| Part | Monthly cost |
| --- | --- |
| GitHub private repo | $0 |
| Neon free project | $0. Neon's free plan limits the number of projects. `launcher_plan_app` reads the count first. |
| Vercel Hobby project (non-commercial) | $0 |
| Fly app, shared-cpu-1x 256 MB | $0 when stopped. About $2 if always on. The launcher sets auto-stop. |
| Minted OpenRouter key | $0 to make. Spend up to its cap ($2 default). |

Neon and Vercel prices are from their plan pages as known on Nov 25, 2026. I did not check them again today.

## How the gateway connects to the harness

1. The harness gets a new key type: an MCP key. It works only for paths under `/mcp/`. It cannot call the models, so a leak cannot spend OpenRouter credit. It is stored hashed, like user API keys, and Skyler can revoke it on the Users page.
2. Skyler makes one MCP key named `mcp-gateway`.
3. The gateway stores it encrypted in its `upstream_servers` table (gateway phase 4). Upstream URL: `https://ai.skylerfly.com/mcp/launcher`.
4. The gateway lists the harness tools and serves them again with the prefix `harness_` (for example `harness_launcher_plan_app`).
5. The gateway puts read tools in `allowed_tools` and create tools in `allowed_commands`. Create tools use the gateway's `risk: 'sensitive'`, so they also need `confirm: true`. Each agent's allowlist starts empty for create tools.
6. The gateway sends the agent name in a header (`x-gateway-client`). The harness writes it to its log. It is for the log only, not for access.
7. Loop rule: the gateway key that the harness assistant uses does not get `harness_*` tools. This stops harness to gateway to harness loops.

Wake-up: the harness Machine sleeps when idle. A gateway call wakes it. The Interceptor can take some seconds to start (the health check allows 90 s because of LiteLLM). The gateway must wait up to 30 s, then tell the agent "the harness is starting, try again in one minute". Inferred, not tested. Test this in phase 4.

## Safety rules

- Every tool that makes a resource needs `confirm: true` and a fresh `plan_id`. This includes $0 resources, because each one uses a free-tier slot and changes Skyler's accounts.
- Every tool that can cost money shows the dollar estimate in its plan. Today that is a Fly machine and a minted key's cap.
- The launcher never deletes, never buys, never upgrades a plan and never adds a payment method.
- A Fly app always has auto-stop on and one machine at most. A plan that asks for more is refused.
- The launcher never puts a key value in a tool result, a log, a repo file or an error text. Tool results show key names only.
- The launcher writes `.env.example` with names only. Real values go to the host's env vars through its API.
- The harness assistant and chat load the launcher with `askBefore: 'writes'`, so its create tools wait for Allow there too.
- Every launcher call writes a log row: time, caller (harness user or gateway agent), tool, plan, result.
- Builds run on Vercel's Git link or Fly's remote builder, not on GitHub Actions.

## Build order

1. MCP server in the Interceptor. `/mcp/launcher` with the read tools, the MCP key type and the call log. Uses the Apps code that exists. Cost: $0. Test from Claude Code on Skyler's computer.
2. Create tools for Vercel and Neon. Plan and confirm, repo from template, Neon project by API, Vercel project linked to the GitHub repo, `DATABASE_URL` set on Vercel. Skyler adds `NEON_API_KEY` as a Fly secret. `runner/hosting.js` stops writing `deploy.yml` when the host builds from its Git link, and the CI workflow becomes optional, to save Actions minutes. Cost: $0.
3. Key store. `launcher_keys` and `launcher_key_uses` tables, the paste page, minted OpenRouter keys per app, attach, rotate and graduate. Needs `ENCRYPTION_KEY` set on Fly. Cost: $0.
4. Gateway hub. Gateway phase 4 adds the harness as an upstream with the MCP key. Muse and Claude Duet get the read tools first. Cost: $0.
5. The harness assistant on the gateway. After the assistant fixes now in progress land, the harness assistant adds the gateway as a remote MCP server (Tools page, `user_mcp`). Then it can use the Tesla tools and the other hub tools like Muse and Claude Duet do. A later step can serve the assistant itself as a harness MCP tool, so the other assistants can ask it questions. Cost: $0, plus model spend on its own key.
6. Fly target, then Netlify for commercial apps. Skyler adds `FLY_API_TOKEN`. Cost: about $2 a month per always-on Fly app.

## Out of scope here

- The assistant code. Another task is fixing it now. Phase 5 starts after that work lands.
- The volume plan in the architecture review doc ("AI harness assistant: architecture review", Nov 17). It is on hold by Skyler. This plan does not change it. The launcher keeps its state in Neon, not on the volume, so it does not depend on that plan.

## Setup steps for Skyler (when a phase starts)

1. Phase 2: make a Neon API key (Neon console, Account settings, API keys) and run `fly secrets set NEON_API_KEY=...`.
2. Phase 2: check that the Vercel GitHub app is installed on the repos the launcher makes (Vercel, Settings, Git).
3. Phase 2: check that `VERCEL_TOKEN` is a Fly secret, with a 90-day expiry.
4. Phase 3: check that `ENCRYPTION_KEY` is a Fly secret (`openssl rand -base64 32`). Without it, the key store refuses to save.
5. Phase 3: check that `OPENROUTER_MANAGEMENT_KEY` is set, for minted keys.
6. Phase 4: make the `mcp-gateway` MCP key on the Users page and add it to the gateway.
7. Phase 6: make a Fly org token (`fly tokens create org`) and set it as `FLY_API_TOKEN`.

## Open points

- One launcher for one person, or per person on the hosted harness? Plan: owner only at first. Other users see no launcher tools.
- Should the shared OpenRouter key stay at all once minted keys work? Plan: keep it only for tools that cannot take a per-app key.
- Neon's free project limit may be reached with many experiments. The plan tool shows the count. Old experiments can be archived on the Apps page.
