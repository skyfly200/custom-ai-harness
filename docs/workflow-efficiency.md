# Workflow efficiency by model tier

Design note answering: how do we measure what a workflow costs, catch a model going round in loops (spending tokens without getting anything done), and build workflows that use each model tier for what it is good at?

Status: the measurable parts are built (see [What is built](#what-is-built)). The rest is planned and marked as such.

## The question, in parts

1. **Efficiency**: how much did a run spend per thing it got done?
2. **Looping**: when does a run stop making progress, and how much did the stalled part cost?
3. **Tier fit**: does a cheap model finish tasks that need less reasoning, and does a strong model earn its price on the hard ones?
4. **Hints instead of brute force**: when a weak model stalls, can a short hint get it unstuck for less than switching to a strong model for the whole task?

## What counts as progress

A run is a list of steps. Each step is one model reply, plus the tool calls it asked for. A step is **productive** when at least one of its tool calls:

- did not return an error (text starting with `Error`), and
- was not an exact repeat of an earlier call whose result was the same.

A re-run that returns something different (a test that failed, then passes) is progress. A re-run that fails the same way is not. A reply with no tool call that is not `finish` is a step with no progress.

A step with no progress is **wasted**. Its cost (input and output tokens priced by the model that answered) goes to `wastedCost`.

This is deliberately crude. It does not know whether a file edit was the right edit. It measures *motion without new results*, which is the failure Skyler described: a model that keeps trying the same thing.

## Loop signals

Two checks run after each step, in `utils/efficiency.js`:

| Signal | Trigger | Why this number |
|---|---|---|
| Repeats | the same call (name and arguments) appears 3 times in the last 8 calls | The agent already blocks 3 identical calls in a row; this also catches a call repeated with other calls between. |
| Stall | 4 steps in a row with no progress | Long enough that a slow but real step (a big test run) does not count. |

When either fires:

1. **First time in a run: a hint.** The harness adds a message to the model's history naming what repeated or stalled, and asks for a different first step or a call to `finish` that says what blocks it. It costs one short message, and it is the cheapest intervention.
2. **Still stuck after a hint: escalate.** The run climbs one effort rung, the same mechanism the run already uses for failures (`runner/escalate.js`). The routing's `maxTier` still caps what it can reach.

Both are recorded as `loop` events on the run, so the run page and the measurements can show them.

## Measurements

Per run (kept on the run record as `efficiency`):

- `steps`, `productive`, `wasted` (steps), `wastedCost`, `wastedTokens`
- `loops` (hints given), `escalations`

Per model, over a set of runs (`GET /runs/efficiency`):

- runs, finished (status `done`), success rate
- total cost, **cost per success** (total spend divided by successful runs, so failed and looping runs make the number worse, as they should)
- steps per success, wasted share of cost, runs that looped, runs that escalated and how many of those succeeded

A run is grouped under the model that made most of its calls. A run that escalated is counted once, under its first model, so the escalation columns say whether escalating paid off.

"Success" is status `done`: the run finished and, for a workflow with a Verifier, the Verifier said PASS. It does not measure whether the change is good; the reviewer and the person still do that.

## Tier fit: which work suits which tier

The working hypothesis, to be tested with the numbers above rather than assumed:

- **Weak / cheap tier**: short, well-specified steps (a rename, a test fix with the failing output in front of it, a file read). Breaks down on open-ended search and on a loop it cannot see out of.
- **Strong tier**: planning, unclear failures, reviewing a diff, anything where the model has to hold several facts at once.
- **Hint from a stronger model**: a few lines of plan written by the strong tier, then the weak tier carries it out. Costs one strong call, instead of a strong run.

The measurements tell us which of these holds for our models. A workflow stage that always escalates is a stage that should start on the stronger model.

## What is built

- `utils/efficiency.js`: the pure rules. Progress, loop watch, hint text, per-run tally, grouping by model.
- `runner/agent.js`: each step ends with a `step-end` event saying whether it made progress, and the loop watch can return a hint (added to the model's history) or an escalation request, which the runner handles.
- `runner/runs.js`: keeps the per-run `efficiency` tally from the run's events, and climbs effort on an escalation request.
- `GET /runs/efficiency` on the runner, via the Interceptor's `/ui/api/runs` proxy: the per-model table.
- Tests: `test/efficiency.test.js` (rules and grouping), and a loop case in `test/runnerAgent.test.js`.

## Not built yet

- **Hints written by a stronger model.** Today the hint is a fixed sentence from the harness. The next step is to ask the strong tier for a short plan when a weak run stalls, and to measure whether that beats escalating the whole run.
- **A page.** The table is only an API for now. It belongs on the Usage page, next to the savings numbers.
- **Measured tier fit per workflow stage.** The per-stage split needs more real runs first. Nothing here has run on a real model yet; the thresholds (3 repeats in 8, 4 stalled steps) are guesses to tune after the first real runs.
- **Token estimates for a run that was cut off.** A run that stops mid-step has its last step unclassified.

## Open questions for Skyler

- Is a cost per success the right headline, or do you want cost per *accepted* change (one the person merged)?
- Should a loop hint ever stop a run, or only nudge it? Right now it only nudges, and escalates at most the effort rungs a run already allows.

## Comparing two models on one prompt

`POST /runs/compare` (via `/ui/api/runs/compare`) takes one task and two different models. It starts two runs with the same goal and repo, each tagged with a comparison id. `GET /runs/compare/:id` then gives both runs and `utils/efficiency.js` `compareRuns`:

- **Like for like.** `sameTask` is false when the goals or repos differ. The verdict says so instead of comparing.
- **Per number, a winner:** finished, steps, steps that moved the work on, wasted steps and share, cost, tokens, cost and tokens per step, cost per productive step, loop hints, escalations.
- **Where the cost gap comes from.** The gap is split exactly into `fromSteps` (the difference in step count, priced at the other run's cost per step) and `fromCostPerStep` (the same number of steps, each dearer or cheaper). That answers "is the stronger model cheaper because it needs fewer steps, or because each of its calls is smaller?"
- **Verdict** in plain words, for example "weak-x finished for $0.1000, 67% less than strong-y".

Limits: the two runs are real runs, so they are not identical. Sandbox timing, the model's own choices and any random step can differ. One comparison is an anecdote; several prompts on the same pair of models is evidence. A comparison also does not check that the two changes are equally good. The reviewer still does that.
