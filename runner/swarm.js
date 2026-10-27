// A swarm: a planner splits the goal into parts, a worker per part runs as an
// ordinary run on its own branch (so they work in parallel, as many at once as
// RUNNER_MAX_RUNS allows), the finished branches are merged into the swarm's
// own branch, and a reviewer checks the combined result. The swarm's record
// lists its workers; each worker has its own page entry and approvals.
'use strict';

const MAX_PARTS = 5;
const TERMINAL = new Set(['done', 'failed', 'stopped', 'incomplete']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKFLOWS = new Set(['general', 'fix-bug', 'build-feature', 'refactor']);

const PLANNER = {
    id: 'plan', role: 'Planner', tools: 'read', maxSteps: 15, effort: 'high', verdict: false, retryTo: null, maxRetries: 0,
    prompt: `Split the task into independent parts that several engineers can work on at the same time, each on its own branch. Read the code first. Parts must touch different files, so their changes merge cleanly; if the task is small or cannot be split safely, return one part. At most ${MAX_PARTS} parts. Do not change any file.
Call finish with ONLY a JSON object, no other text: {"parts":[{"title":"short name","task":"what this engineer must do, with the files involved and how to check it","workflow":"general"}]}. "workflow" is one of general, fix-bug, build-feature, refactor.`,
};

const REVIEWER = {
    id: 'review', role: 'Reviewer', tools: 'check', maxSteps: 15, effort: 'medium', verdict: true, retryTo: null, maxRetries: 0,
    prompt: 'The parts of the task were done by separate engineers and merged into this workspace. Check that the combined result does the whole task and the parts fit together: run the project\'s tests and read the diff (`git diff HEAD~0` is empty after a merge, so use `git diff <base>..HEAD` with the base given in the context). Do not change any file. Start your finish summary with PASS if the whole task is done and the tests pass, or FAIL followed by exactly what is missing or broken.',
};

/** The parts a planner's reply describes; a single part with the whole goal if it can't be read. */
function parsePlan(text, goal) {
    const whole = [{ title: 'Whole task', task: goal, workflow: 'general' }];
    const start = String(text || '').indexOf('{');
    const end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < start) return { parts: whole, note: 'The planner did not return a plan; running the task as one part.' };
    let raw;
    try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return { parts: whole, note: 'The planner\'s plan was not valid JSON; running the task as one part.' }; }
    const parts = (Array.isArray(raw?.parts) ? raw.parts : [])
        .filter((p) => p && typeof p.task === 'string' && p.task.trim())
        .slice(0, MAX_PARTS)
        .map((p, i) => ({ title: String(p.title || `Part ${i + 1}`).slice(0, 80), task: p.task.trim().slice(0, 8000), workflow: WORKFLOWS.has(p.workflow) ? p.workflow : 'general' }));
    return parts.length ? { parts } : { parts: whole, note: 'The plan had no parts; running the task as one part.' };
}

async function executeSwarm(manager, run, live) {
    const { createSandbox } = require('./sandbox');
    const path = require('path');
    const sandbox = await createSandbox({ kind: run.sandbox || manager.sandboxKind, repo: run.repo, dir: path.join(manager.dir, run.id, 'work'), branch: run.branch, base: run.base || 'HEAD' });
    live.sandbox = sandbox;
    run.base = sandbox.base;
    if (sandbox.kind === 'e2b') { run.sandboxId = sandbox.id; manager.save(run); }
    manager.event(run, { type: 'note', text: `Swarm on branch ${run.branch} from ${sandbox.base.slice(0, 10)}${sandbox.kind === 'e2b' ? ` in an E2B sandbox (${sandbox.id})` : ''}.` });
    const files = (await sandbox.git(['ls-files'])).split('\n').filter(Boolean);
    const context = `The workspace has ${files.length} tracked files. First ones:\n${files.slice(0, 150).join('\n')}${files.length > 150 ? '\n…' : ''}`;
    let n = 0;
    const deadline = Date.now() + run.maxMinutes * 60000;
    const stage = (s, extra = '') => manager.runStages({ run, live, sandbox, workflow: { stages: [s] }, context: context + extra, deadline, nextN: () => ++n });

    const planned = await stage(PLANNER);
    if (planned.status !== 'finished') return { status: planned.status, summary: `Planning: ${planned.summary}` };
    const plan = parsePlan(planned.summary, run.goal);
    if (plan.note) manager.event(run, { type: 'note', text: plan.note });
    run.parts = plan.parts;
    manager.event(run, { type: 'plan', text: plan.parts.map((p, i) => `${i + 1}. ${p.title}`).join('\n') });

    run.children = plan.parts.map((p) => manager.create({
        goal: `${p.task}\n\nThis is one part of a larger task that several engineers do at once, each on their own branch: "${run.goal}". Do only your part and leave files that belong to other parts alone.`,
        repo: run.repo, base: run.base, workflow: p.workflow, profile: run.profile, model: run.model, effort: run.effort,
        maxSteps: run.maxSteps, maxMinutes: run.maxMinutes, parent: run.id, autoDebug: run.autoDebug,
    }).id);
    manager.event(run, { type: 'note', text: `Started ${run.children.length} worker${run.children.length === 1 ? '' : 's'}.` });
    manager.save(run);

    while (run.children.some((id) => !TERMINAL.has(manager.get(id).status))) {
        if (live.stopped) {
            for (const id of run.children) { try { manager.stop(id); } catch { /* already finished */ } }
            return { status: 'stopped', summary: 'Stopped by a person.' };
        }
        await sleep(manager.pollMs);
    }

    const merged = [];
    const skipped = [];
    // a cloud sandbox has no copy of the workers' branches (they are in the repo here), so they
    // are handed over as bundles first; on this machine a worktree already sees them
    const toMerge = run.children.filter((id) => { const c = manager.get(id); return c.status === 'done' && c.result?.commit; });
    if (sandbox.importBranches) await sandbox.importBranches(toMerge.map((id) => manager.get(id).branch));
    for (const [i, id] of run.children.entries()) {
        const child = manager.get(id);
        const title = plan.parts[i].title;
        if (child.status !== 'done' || !child.result?.commit) { skipped.push(`${title}: ${child.status === 'done' ? 'changed nothing' : child.status}${child.error ? ` (${child.error})` : ''}`); continue; }
        try {
            await sandbox.git(['-c', 'user.name=Bright Chat runner', '-c', 'user.email=runner@localhost', 'merge', '--no-ff', '-q', '-m', `Merge ${child.branch}: ${title}`, child.branch]);
            merged.push(title);
            manager.event(run, { type: 'note', text: `Merged “${title}” (${child.branch}).` });
        } catch (err) {
            await sandbox.git(['merge', '--abort']).catch(() => {});
            skipped.push(`${title}: conflicts with the other parts, so its branch ${child.branch} was left out`);
            manager.event(run, { type: 'note', text: `Could not merge “${title}”: ${err.message.split('\n')[0]}` });
        }
    }
    const lines = [`Merged ${merged.length} of ${plan.parts.length} parts${merged.length ? `: ${merged.join(', ')}` : ''}.`, ...skipped.map((s) => `Left out - ${s}`)];
    if (!merged.length) return { status: 'incomplete', summary: lines.join('\n') };

    const workers = run.children.map((id, i) => `${plan.parts[i].title} (${manager.get(id).status}): ${manager.get(id).result?.summary || manager.get(id).error || ''}`).join('\n');
    const review = await stage(REVIEWER, `\n\nThe base commit is ${run.base}.\nThe parts and what each engineer reported:\n${workers}\n${lines.join('\n')}`);
    const failed = /^\W*FAIL/i.test(review.summary);
    run.swarmSummary = lines;
    return { status: review.status === 'finished' && !failed && !skipped.length ? 'finished' : review.status === 'finished' ? 'incomplete' : review.status, summary: `${lines.join('\n')}\n\nReviewer: ${review.summary}` };
}

module.exports = { executeSwarm, parsePlan, PLANNER, REVIEWER, MAX_PARTS };
