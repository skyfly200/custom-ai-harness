# ChatDev as an external tool

Run [ChatDev 2.0](https://github.com/OpenBMB/ChatDev) (OpenBMB, Apache-2.0) inside a cloud sandbox, with every model call going through this harness. Back to the [README](../README.md).

ChatDev is a separate multi-agent platform: YAML workflows of agent, human and Python nodes, run by its own server. The harness doesn't reimplement it. The **ChatDev** workflow on the Agents page starts a [Fly Sprite](task-runner.md#cloud-sandboxes-e2b-and-fly-sprites) (or an E2B sandbox), installs ChatDev there, points its models at the harness, runs one workflow and commits what it wrote.

## Why a sandbox

ChatDev's agents write files and run commands on their own, outside the [command guard](claude-code.md#command-guard-jev-checks-commands-before-they-run). The Sprite is the boundary: it has none of your files, and the only credential in it is `CHATDEV_API_KEY`. Everything they produce comes back as a normal `harness/<id>` branch in your repo to review.

## Set it up

1. Make the Sprite driver work first (`SPRITES_TOKEN`, see the task runner page).
2. The sandbox must reach the harness, so it needs a public address: a [Cloudflare tunnel](phone-and-app.md) or your [server](server-docker.md), with `HARNESS_PASSWORD` set. `localhost` is refused.
3. Create an API key for ChatDev under **Users** ([Named logins and API keys](logins.md)) rather than using your password.
4. In `.env`:

   ```
   CHATDEV_HARNESS_URL=https://your-harness.example.com
   CHATDEV_API_KEY=hk_...
   ```

   Optional: `CHATDEV_MODEL` (the model name the workflow sends, default `claude-sonnet-5-5`; the routing still picks the real model), `CHATDEV_WORKFLOW` (path to your own ChatDev YAML), `CHATDEV_REPO` and `CHATDEV_REF` (install a fork, branch or tag).
5. On the Agents page choose Workflow **ChatDev (in a cloud sandbox)**, describe what to build, and start. The sandbox defaults to a Sprite.

## What happens

1. The sandbox starts with your repo on branch `harness/<id>`.
2. ChatDev is cloned and installed next to it (`uv sync`; a few minutes each run, no snapshot yet).
3. A `.env` is written in the sandbox with `BASE_URL=<harness>/v1`, `API_KEY` and `MODEL_NAME`, which `chatdev/dev-team.yaml` uses as `${BASE_URL}`, `${API_KEY}` and `${MODEL_NAME}`. Calls show in your routing log, Usage page and Langfuse like any other client.
4. ChatDev's server starts and the run posts your goal and the YAML to `POST /api/workflow/execute`.
5. ChatDev's response, its `WareHouse` output and the end of its server log are saved under `chatdev-output/<id>/` and committed. The sandbox is deleted.

The default workflow is a Planner, Programmer and Reviewer with a review loop (the reviewer replies ACCEPT to finish). Copy `chatdev/dev-team.yaml` and set `CHATDEV_WORKFLOW` to use your own, or build one in ChatDev's own web editor and export its YAML.

## Limits

- **Not tried against a real ChatDev yet.** The YAML and the API call follow ChatDev's authoring guide; the tests use a stand-in sandbox. If ChatDev rejects the file, the run fails with its answer, and the fix is in the YAML.
- The run is one call: no live progress and no Stop in the middle of ChatDev's work (Stop ends the run at the next step).
- No cost cap per run yet. Cap the key's spending in the harness, and keep `maxMinutes` low.
- Only the default workflow's nodes are checked. Python nodes in your own YAML run in the sandbox.
- The ChatDev run can't be continued, only started again.
