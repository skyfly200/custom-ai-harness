# Task runner, workflows and swarm

Agents that do a whole task on their own branch, in a worktree or a cloud sandbox. Back to the [README](../README.md).

## Task runner (agents that do a whole task)

The **Agents** page (it was called Runs; `runs.html` still forwards there) gives an agent a goal, such as "fix the failing test in `utils/tiers.js`", and lets it work until it is done. The agent reads and edits files and runs commands in its own copy of your repo, using the models your routing picks. When it finishes you get a summary and the changes.

How it keeps your work safe:

- **Its own branch.** Each run is a `git worktree` of your repo on a new branch named `harness/<id>`, or (with `RUNNER_SANDBOX=e2b`) a [cloud sandbox](#cloud-sandboxes-e2b) that gets the same branch. Your checked-out files are never touched. Review the branch with `git diff <start>..harness/<id>` (the page shows the exact command) and push it yourself if you like. Nothing is ever pushed or published for you.
- **Every command and file write goes past the [command guard](claude-code.md#command-guard-jev-checks-commands-before-they-run).** Dangerous ones are refused, risky ones wait on the Agents page for you to **Allow** or **Decline** (no answer for 15 minutes counts as decline), and an unreachable guard counts as "ask".
- **Only chosen folders.** Repos must be inside `RUNNER_ROOTS` (default the `repos` folder next to the harness; set it in `.env`, separating folders with `;` on Windows). Files the agent reads and writes must stay inside its workspace, and `.git` is off limits.
- **One working tree per chat.** Linking a repo to a chat gives it a persistent `git worktree` on its own `harness/chat-…` branch. Chats linked to the same repo therefore do not share uncommitted edits or shell commands, and the original checkout is left alone. A chat's worktree starts at the linked repo's current `HEAD`; it does not copy uncommitted files from the original checkout. Worktrees are kept under `data/chat-worktrees` (or `CHAT_WORKTREES_DIR` if set) so the chat can resume in the same workspace later.
- **No keys.** Commands the agent runs get a trimmed environment, so they can't print the harness's API keys.
- **Faster local tool rounds.** Independent file and directory reads requested together run concurrently; writes and shell commands stay ordered. On Windows, local runs and the linked-repo shell reuse a PowerShell process, while starting each command back in the repository root. A run's shell closes when that run ends.
- **Plan mode.** Tick **Plan only, change nothing** on the form, or start one from a chat with `/plan TASK`. The agent reads and searches the repository but is offered no shell, write or edit tool, so it cannot change files or run commands. Its rules tell it to answer with the plan itself, and the run makes no commit. What comes back is the plan — what it would change file by file, the order, what to check after each step, and the risks or open questions. Read it, then start the same task without plan mode (or with an agent that has a different model) when you are happy. The Agents page marks such a run **Plan only** and hides the branch and diff, since there is nothing to review.
- **Limits.** Each run stops after its max minutes (30), and at most `RUNNER_MAX_RUNS` (2) run at once. **Max steps** is off by default (0), so a run goes on until the agent calls finish or its minutes run out; set a number to cap the model calls it may make (a workflow stage may also cap its own). **Stop** ends a run, even in the middle of a command.
- **Continue, retry and auto debug.** A run that only ran out of steps or time has **Continue**: the same run, the same `harness/<id>` branch, starting from the commits and the files the earlier part left (what it was saying when it ran out goes into the prompt), with a fresh set of minutes (and steps, if it was capped) rather than whatever was left of the old ones. Nothing went wrong, so it is not a new run and nothing is thrown away; continue it as often as it needs, and the page shows how many parts it took. With no step limit a run only ends this way on its minutes, which is what the default of 30 makes likely on a long task. A run that **failed** has **Retry run** (the same task again from the same commit, on a fresh `harness/<id>` branch) and **Auto debug**: the new agent is told what the earlier attempt got wrong (the error, the failing test output, the last tools it ran and what they returned) and is asked to work out the real cause instead of repeating it. Tick **Auto debug a failed run** on the form (or set `RUNNER_AUTO_DEBUG=1`) and the runner does that by itself, at most 2 generations deep, so a failure it cannot fix stops and waits for you. An earlier run's branch is not deleted, so you can compare the two.

To use it, run `npm run all` (it starts the runner as a fourth part), put a git repo in the `repos` folder or set `RUNNER_ROOTS`, open **Agents** from the top bar, describe the task and press **Start run**. Routing and Effort work as in chat: pick a routing, or **Jev picks (auto)**. Type or paste the repo's path (the field suggests git repos it finds on this computer), pick a recent one, or press **Browse…** to walk through the allowed folders (repos are marked ◆). The agent runs the project's tests itself when the task calls for it.

**Terminal.** A **Terminal** panel under the task list (opens when the selected run has run a command) shows what the agent ran and what came back, in [xterm.js](https://xtermjs.org) (vendored in `ui/vendor/xterm/`, so it needs no install or internet): `$ command`, its output, and a red `[exit code N]` on failure, with stage names, approvals and file reads as dim one-liners. It follows the run live as the page refreshes. It is a replay of the run's record, not a shell: typing in it does nothing, and output is cut to the length the run's record keeps. A live interactive shell in the sandbox is not built.

### Persistent agents

A run is a one-off. An **agent** is a named, long-lived worker for one repo that you give task after task. Press **+ New agent** on the Agents page and set a name, the repo, standing instructions ("keep changes small, run `npm test` before finishing"), one workflow, a routing, an effort, step and minute limits, and optionally a chat project. Pick the agent in the bar to see its tasks and give it a new one.

- **Its work builds up.** Each task is an ordinary run (own `harness/<id>` branch, same guard and approvals), but it starts from the commit the agent's last finished task left, so the branch of task 2 holds task 1's changes too. If you have merged that work into the repo (the commit is an ancestor of the repo's current commit), or the commit is gone, the next task starts from the repo's current commit like any run. Plan-only tasks and tasks that fail leave the starting point where it was.
- **It remembers.** Every task is told the agent's name and instructions and what its last six finished tasks were and reported, then the usual workflow stages.
- **One task at a time.** Tasks given while it is busy wait their turn, in order. Different agents (and one-off runs) work side by side, up to `RUNNER_MAX_RUNS`.
- **Deleting an agent** keeps its tasks as ordinary runs and leaves their branches in the repo. Changing an agent's repo starts its work over from that repo.
- **Old runs keep working.** Runs made before agents existed are one-off runs under **All runs**.
- **Storage.** One JSON file per agent in `runs/_agents/`, read and written only by `runner/agents.js`, so it can be replaced by a database table later. The API is `GET/POST /ui/api/agents`, `GET/PATCH/DELETE /ui/api/agents/<id>` and `POST /ui/api/agents/<id>/tasks` (`goal`, optional `plan`, `maxSteps`, `maxMinutes`, `maxCost`); `/ui/api/runs` is unchanged.

**Agents and chat projects.** A chat project (see [Chat](chat.md)) can have agents. Tick them under **Agents in this project** in the project settings, or choose the **Chat project** in the agent's own form; the agent stores the project's id and name (projects live in your browser, agents in the runner). In a chat, `/agent TASK` hands the task to the project's agent (`/agent NAME TASK` when the project has several; outside a project it picks from all agents). The task carries the last six messages of the chat as context, the chat gets a note linking to the task, and the task on the Agents page links back to the chat. An agent's project name on the Agents page opens that project's chats. An agent belongs to at most one project. `/subagent` still starts a one-off run.

### Workflows (recipes the agent follows)

### Stronger model on failure

A run climbs one effort step (and so, usually, one routing tier) when a model call fails after its usual retries, when a model answers with nothing, or when a Verifier stage says FAIL and the run goes back to retry. It can climb at most twice. **Highest tier** on the run or agent (sent as `x-harness-max-tier`) caps how high it may go, so a retry never costs more than you allowed. Untick **Try a stronger model when something fails** (or send `escalate: false`) to turn it off. Each climb is a note in the run's log, and the run shows `Escalated N×`. A request the harness rejects outright (HTTP 400, 401) does not escalate.

A workflow is a short list of stages. Each stage is its own agent loop with a role, the tools it may use, a step budget and optionally an effort, and it is handed what the stages before it found. The recipes live in `workflows/*.json`, one file each:

| Workflow | Stages | Fits |
| --- | --- | --- |
| Quick answer | Explainer (read-only) | a question about the code |
| Fix a bug | Investigator (reads, runs tests), Implementer, Verifier | a bug report or failing test |
| Build a feature | Planner (high effort), Implementer, Verifier | new behaviour |
| Refactor | Planner (runs the tests first), Implementer, Verifier | restructuring without changing behaviour |
| Refactor with an audit loop | Refactorer, Auditor (an adversarial critic) | a big or risky refactor; the critic sends it back up to 3 times until it finds nothing real |
| Review | Reviewer, Skeptic (tries to disprove each finding) | "review this branch", changes nothing |
| Research the code | Reader, Writer | how something works, changes nothing |
| Do the task | Engineer | anything else (the fallback) |

Tool sets: `read` (list, read), `check` (also run commands) and `all` (also write files). A **Verifier** starts its summary with PASS or FAIL; FAIL sends the run back to the Implementer once, with what was wrong, and a second FAIL stops the run for you to look at.

**Audit each part of a swarm.** Tick **Audit each part of the swarm** (shown with the Swarm workflow) and each worker whose workflow would have been *Do the task*, which is every worker from a ticket draft, runs *Build with an audit* instead: an Implementer, then an Auditor who sends its list of real problems back to the Implementer up to 2 times. A worker the Auditor still rejects after that finishes `incomplete` and is left out of the merge like any failed part. Slower and dearer, so off by default. API: `auditParts` on a swarm run.

**Audit loop.** *Refactor with an audit loop* is a Refactorer and an Auditor whose job is to prove the work wrong: it reads the diff, runs the tests and reports only problems it checked. Its `FAIL` list goes back to the Refactorer, and this repeats for up to 4 rounds in all (`maxRetries: 3`; any verdict stage may set up to 5). The run log says which round it is. If the Auditor still says FAIL after the last round, the run ends `incomplete` for you to look at, with the Auditor's list as the summary. A stage may set `"model": "some-gateway-model"` so the critic is a different model than the one whose work it checks (add it to `workflows/audit-refactor.json`; a model pinned on the run itself overrides it).

**Batch stages (half price, can wait).** A stage with `"canWait": true` and a `"model"` (an OpenRouter id) is one request with no tools, sent through OpenRouter's Batch API at about half price and waited for. It gets the task, what earlier stages found and, with `"diff": true`, the workspace's `git diff`. That suits a critic, a summary or a review of finished work, not an implementer that needs tools. Example stage: `{ "id": "critic", "role": "Critic", "canWait": true, "model": "anthropic/claude-sonnet-5.5", "diff": true, "verdict": true, "retryTo": "implement", "prompt": "..." }`. The run polls every 30 s (`RUNNER_BATCH_POLL_MS`) and holds its place while it waits; Stop works. Batches usually finish in minutes but may take up to 24 h; after `maxWaitMinutes` (default 120) the stage gives up and asks the model normally. It also asks normally, with a note in the log, when the model is not listed in `batch-models.json`, there is no OpenRouter key, or the batch fails. The run's cost counts the batch at half price and the run shows what that saved. The Interceptor talks to OpenRouter directly (`POST /v1/batch`, `GET /v1/batch/:id`) because LiteLLM's batch support does not cover OpenRouter. Not yet done: pooling several runs' requests into one batch, and swarm fan-out. Checked only against a fake OpenRouter: the request body follows OpenRouter's docs, but the result entry's exact shape is read defensively and may need a fix on first real use.

On the Runs page the Workflow box is **Jev picks (auto)** by default. A moment after you stop typing the goal, Jev is asked one yes/no question per recipe ("Is this task a bug report, a failing test or an error message...?"), the best answer at 50% or more wins (otherwise "Do the task"), and the pick is shown under the box. Choose another workflow in the box to override it. To add your own recipe, copy a file in `workflows/`, change the `id`, `name`, `when` (the sentence Jev is asked about) and `stages`; a file with a mistake is skipped and listed by `GET /ui/api/workflows` under `problems`. Set `HARNESS_WORKFLOWS_DIR` to keep recipes elsewhere.

### Swarm (several agents on one task)

Choose **Swarm (several agents at once)** in the Workflow box for a task that splits into separate parts. It runs in four steps:

1. A **Planner** (read-only, high effort) reads the repo and splits the goal into up to 5 parts that touch different files. If its plan can't be read, the whole task runs as one part.
2. A **worker** per part starts as an ordinary run (its own branch, its own approvals, the workflow the planner chose for it). They run side by side, as many as `RUNNER_MAX_RUNS` (default 2) allow, and the rest wait their turn.
3. Each finished branch is merged into the swarm's own branch `harness/<id>`. A part that fails, changes nothing or conflicts with another is left out and named in the summary; its branch stays in your repo.
4. A **Reviewer** runs the tests and checks that the combined result does the whole task.

The swarm's page lists its workers; click one to watch it or answer its approval. Stopping the swarm stops every worker. A swarm is marked finished only when every part merged and the reviewer said PASS. Raise `RUNNER_MAX_RUNS` for more workers at once (each one is a stream of model calls, so mind your rate limits).

**From a ticket draft.** `/wayfinder GOAL` in Claude Code returns a JSON draft of tickets. Paste it into **Ticket draft** on the Agents page (shown when Swarm is chosen), or send it as `tickets` with a swarm run, and the planner is skipped: the swarm works the draft's `build` tickets instead. Each ticket's description and acceptance criteria become its worker's task. Tickets run in waves by `depends_on`: a ticket starts once the build tickets it depends on are merged, from the swarm branch as it stands, so it sees their changes. A ticket whose dependency was left out (failed, empty or conflicting) is left out and named in the summary. Research, decision and `build_parent` tickets are not code to write and are skipped; dependencies on them are not waited for. At most 12 build tickets. Dependent waves need the local sandbox (not `RUNNER_SANDBOX=e2b`); a draft whose tickets are all independent works in both. **Save as markdown files…** under the draft writes it into the repo (see below).

**Compatible with Matt Pocock's wayfinder** ([mattpocock/skills](https://github.com/mattpocock/skills)). His map is a `wayfinder:map` issue (Destination, Notes, Decisions so far, Not yet specified, Out of scope) with child issues labelled `wayfinder:research|prototype|grilling|task`, a `## Question` body and native blocking. Our draft maps onto it: `destinations` are the Destination, `fog_of_war` is Not yet specified, `depends_on` is blocking, and each ticket carries a `wayfinder_type`. In the other direction, paste issues from `gh issue list --json number,title,body,labels` (blocked by a `Blocked by: #n` line or a `blocked_by` list) into the Ticket draft box and they are read as tickets. His tickets are decisions, so they are not run; an issue that also has a `build` label is. `toWayfinderMap()` in `runner/tickets.js` turns a draft into his map body and labelled tickets, ready to file.

**Tickets as markdown files.** **Save as markdown files…** (under Ticket draft on the Agents page; or `POST /ui/api/tickets/files` with `tickets`, `repo` and `confirm: true`) shows the files it will write and asks, then writes `wayfinder/<map>/map.md` and one file per ticket into the repo (a numbered folder if that map exists already). `map.md` holds his five sections, with the tickets listed as tasks in Notes. Each ticket file has front matter (`id`, `title`, `labels` such as `wayfinder:task` and `build`, `blocked_by`, `status`), a `## Question` body, and `Blocked by:` and `Part of` links to the other files. Blockers come first in the order. They are plain files: read them, edit them, tick them off, commit them. **Load from a folder…** (or `POST /ui/api/tickets/read` with `repo` and `folder`) reads such a folder, including hand-written ones with the same front matter, back into the Ticket draft box for a swarm; files without an `id` are skipped. Nothing is sent to GitHub. Checked against temporary repos only.

Notes:

- The runner is its own process (`node runner/server.js`, port 3100, only reachable from this machine). The Interceptor passes the Agents page's requests to it after its own login check, and `npm run all` sets a shared `RUNNER_TOKEN` so nothing else on the machine can drive it. If you start the parts yourself, set the same `RUNNER_TOKEN` in `.env` for both.
- Run records are kept in `runs/` (gitignored). A run that was in progress when the runner stopped shows as failed; its branch keeps whatever was committed. The record is written to a temporary file and renamed into place; where Windows refuses the rename for a moment (a virus scanner or the indexer holding `run.json` open, `EPERM`) it retries, then writes in place, so a run is never lost to that.
- It runs under Docker with `COMPOSE_PROFILES=runs` (see [Cloud sandboxes](#cloud-sandboxes-e2b) for the setup), which on a server is how to use it.
- Tested with a scripted model, not with real models or on Windows (commands run in PowerShell there).

See also [ChatDev as an external tool](chatdev.md), a workflow that runs the ChatDev multi-agent tool in a cloud sandbox.

### Cloud sandboxes (E2B and Fly Sprites)

A run can work in a sandbox in the cloud instead of a worktree on this machine: the agent's commands then run in a Linux VM, never on your PC. Two providers are built in, and **Sandbox** on the Agents page (for a one-off run, and in an agent's settings) picks one per run or per agent; `RUNNER_SANDBOX` (`local`, `e2b` or `sprites`) is the default for runs that pick none. A provider whose key is not set shows as disabled in the picker, and the API refuses it.

| Sandbox | Needs | Notes |
|---|---|---|
| `local` | nothing | a git worktree here |
| `e2b` | `E2B_API_KEY` | [E2B](https://e2b.dev) Firecracker VMs, billed while running |
| `sprites` | `SPRITES_TOKEN`, and `npm install @fly/sprites` (optional dependency, needs Node 24+) | [Fly Sprites](https://sprites.dev): Linux VMs that cost nothing while idle; the Sprite is named `harness-…`, work lands in `/home/sprite/work` (`SPRITES_WORKDIR`) |

Every driver offers the same methods, so the workflows, tools, guard and approvals are identical on all three: each command and file write still goes past `/v1/guard` before it reaches the sandbox. A swarm's workers use the swarm's sandbox. The Sprites driver is only tested against a stand-in so far, not a live Fly account.

For E2B, set `RUNNER_SANDBOX=e2b` and `E2B_API_KEY` in `.env` (the key is on your E2B dashboard; get one from the free tier), keep the repo in `RUNNER_ROOTS` as usual, and start the runner as always. Nothing else changes: the same workflows, tools, guard and approvals apply, and the run page looks the same.

How the branch gets there and back:

1. The base commit of your repo is packed into a git bundle and written into a fresh sandbox (template `E2B_TEMPLATE`, default `base`), which checks it out on a branch `harness/<id>` of its own in `/home/user/work` (set `E2B_WORKDIR`).
2. The agent works there; every file call and command goes to the sandbox.
3. When the run ends, everything is committed and the branch is packed back into a bundle and fetched into your repo here, so `git diff`, **Continue**, **Retry** and pushing work exactly as with a local run. A swarm's own branch is handed back after its merges, and each worker's branch is handed *to* it before they are merged. A continued run gets a new sandbox holding its branch as it stands.
4. The sandbox is killed (a Sprite is deleted) as soon as the run ends (and if the runner is restarted mid-run), so nothing keeps billing. Its record keeps the sandbox id.
5. On a Docker server, the runner is a container (`COMPOSE_PROFILES=runs`) whose commands all go to the sandbox; see below.

Notes:

- A sandbox lives at most `E2B_MAX_TIMEOUT_MIN` minutes (default 60, the free tier's cap; E2B answers "Timeout cannot be greater than 1 hours" above it). On Pro set it higher, up to 1440. A run longer than the cap ends when its sandbox does.
- The cloud sandbox has no copy of your other branches, and `E2B_API_KEY` is never given to the commands the agent runs.
- The run's own record and the branch stay here, in `runs/<id>/run.json` and your repo; delete the run to remove the record.
- `apt-get install git` runs once in a new sandbox if the template has no git.
- Reading files, listing folders and running commands are network calls now, so a cloud run is slower per step than a local one; `MAX_OUTPUT` trimming and the run's step and minute limits work as before.

**On a Docker server.** The runner has its own container. Set these in `.env` on the server, then `docker compose up -d --build`:

```
COMPOSE_PROFILES=runs
RUNNER_TOKEN=any-long-random-text
E2B_API_KEY=e2b_...
RUNNER_SANDBOX=e2b            # the compose default for this container
```

The runner comes up beside the Interceptor (`http://runner:3100`, no ports published) and the Interceptor sends it the Agents page's requests with the same `RUNNER_TOKEN`, so nothing else on the network can drive it. Runs and their branches land in the `runs` and `repos` folders on the server, so **Continue**, **Retry** and `git diff` work as they do on your PC, and the branch is pushed from the server. Local mode is possible too but pointless there: the worktree is made from the copy of the repo in `repos`, and commands run inside the runner's image, which has only Node and git.

## Apps (in-app agents, step 2)

An app is a repo you can ask for changes: on the Agents page, **Register an app** with its repo, the paths an agent may edit (`ui/**`, one per line; `*` stays in one folder), an optional dev server command (`{port}` is filled in) and test command. **Ask for a change** starts a run on the `change-app` workflow (implement, then verify).

- The write and edit tools refuse any file outside the editable paths. A command can still write anywhere, so after the run the changed files are checked too: anything outside is listed in the result and the run ends `incomplete` instead of `done`.
- The run's test command runs at the end, and Preview uses the app's dev command when you give none.
- What the person was looking at (`context` in `POST /apps/:id/changes`) is passed to the agent as untrusted data.
- Registrations live in `runs/_apps/`. API: `GET/POST /apps`, `GET/PATCH/DELETE /apps/:id`, `POST /apps/:id/changes` (also under `/ui/api/apps`).

### Ship and undo

A finished change shows a **Ship this change** panel: files and lines changed, whether the tests pass, and notes (large change, sensitive files such as auth, payments, migrations, `.env`, workflows). **Approve and merge** stays off while the run did not finish, made no commit, changed files outside the editable paths or its tests fail. The notes are advice; the person decides.

Approving pushes the run's branch, opens a pull request and merges it on GitHub (`GITHUB_TOKEN` in `.env` with Pull requests and Contents write; the repo comes from the app's *GitHub repo* or its `origin` remote, the target from *Base branch* or `origin/HEAD`). The app's own pipeline deploys after the merge; with deploy method `hook` the runner also POSTs the app's hook URL. **Undo** opens and merges a revert pull request for the merge commit. API: `GET/POST /runs/:id/ship`, `POST /runs/:id/undo`. Git history is the audit trail.

### The "Change this page" widget

`ui/agent-widget.js` is already on every harness UI page (`<script src="agent-widget.js" data-app-name="Harness UI" defer>`). It shows a **Change this page** button only when an app with that name (or `data-app="<id>"`) is registered on the Agents page, so register the repo as "Harness UI" with editable paths such as `ui/**` to turn it on. You write what should change, optionally click **Pick an element**, and it starts a change run with the page, the picked element, selected text and recent console errors as context (the agent is told this is untrusted data). Progress shows in the panel; preview, approve and undo are on the Agents page. For another app served from the same address, add the script with its own `data-app-name`.

### Proposals

The widget's **Propose a fix only** (or `POST /apps/:id/proposals` with `kind` `error` or `feedback`, a `note` and the page `context`) runs a change that can only end as an **open pull request**: never merged, never deployed, a draft when it touches sensitive files. A page that hit console errors sends them as the problem; without errors it is a "this is confusing" note. It needs `GITHUB_TOKEN` like shipping; without it the branch is left in the repo and the run log says so. Limits: 3 proposals an hour per app (`RUNNER_PROPOSALS_PER_HOUR`), and the same problem is not proposed again while its earlier proposal is open or running (HTTP 429).

## Cost

Every model call a run makes is priced like the Usage page (the runner reads `/ui/api/model-info`; a cost the provider reports wins). A run record has `cost` (dollars) and `unpricedCalls` (calls to models with no known price, shown as `$1.20+`). A swarm's cost includes its workers.

**Cost limit.** `maxCost` (dollars, on a run, on an agent, or on a task) stops a run when it has spent that much. It ends as `incomplete` with `outOfBudget: true` and shows as "cost limit"; Continue carries it on with the whole limit again, like steps and minutes. A call that is already running finishes, so a run can go a little over. 0 or blank means no limit. On a swarm each worker gets the limit; the swarm's own planner and reviewer count against it too.

The Dashboard shows run spend per day, stacked by the four agents that spent most (the rest are "Other"). A run counts on the day it started.

## Repo suggestions

The repo fields (Agents, and chat Options > Tools and project settings) suggest git repos found on this computer. The harness looks in `REPO_SCAN_ROOTS` (folders separated by `;` on Windows, `:` elsewhere); if that is unset, in `RUNNER_ROOTS` and `HARNESS_FILE_ROOTS`; if those are unset too, in the folder that holds the harness and common code folders in your home folder (`code`, `projects`, `dev`, `src`, `repos`, `Documents/GitHub`). It goes three folders deep and does not look inside a repo. Typing a path still works. A hosted server never scans its own disk: there the fields suggest the GitHub repos you connected.
