// Workflows page: the pure part of the editor. No DOM here, so the test can check it.
//
// A workflow is a list of stages (see utils/workflows.js). The page draws them as
// boxes in order, joined by arrows, with a dashed arc back from each Verifier to
// the stage it sends work back to. Everything that turns a stage into words, or
// checks a stage before it is saved, lives here.
//
// Loaded by the page with a plain <script>, and by Node (module.exports) in the tests.
(function (root) {
  'use strict';

  const TOOLS = {
    read: { label: 'Reads only', text: 'can look at files and search, but change nothing and run nothing' },
    check: { label: 'Reads and runs', text: 'can read files and run commands such as tests, but cannot change files' },
    all: { label: 'Everything', text: 'can read, run commands and change files' },
    none: { label: 'No tools', text: 'gets the text it is given and answers in one reply; it cannot look at the project' },
  };
  const EFFORTS = [
    { value: '', label: 'Default', text: 'the run’s own effort' },
    { value: 'min', label: 'Minimum', text: 'the least thinking, the cheapest model' },
    { value: 'low', label: 'Low', text: 'quick, little thinking' },
    { value: 'medium', label: 'Medium', text: 'a balance of care and cost' },
    { value: 'high', label: 'High', text: 'careful, for hard reasoning' },
    { value: 'max', label: 'Maximum', text: 'the most thinking, the dearest' },
  ];
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

  const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  function stage(over = {}) {
    return {
      kind: 'agent', id: 'step', role: 'Step', tools: 'all', prompt: '', effort: null, model: null, verdict: false, retryTo: null, maxRetries: 0, maxSteps: 0, canWait: false, maxWaitMinutes: 120, diff: false,
      ask: null, contains: null, question: '', options: [], defaultOption: null, timeoutMinutes: 60, goto: {},
      ...over,
    };
  }

  const KIND_NAMES = {
    agent: 'Works on the task',
    branch: 'Yes or no: sends the run one way or the other',
    human: 'Asks a person a question',
  };

  const isAgent = (s) => !s.kind || s.kind === 'agent';

  /** The outcomes a stage has, and the goto key for each: what a stage's "Where each outcome goes" rows choose from. */
  function outcomesFor(s) {
    if (s.kind === 'branch') return [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }];
    if (s.kind === 'human') return (s.options || []).map((o) => ({ key: o, label: o }));
    if (s.kind !== 'branch' && s.verdict) return [{ key: 'PASS', label: 'PASS' }];
    return [];
  }

  /** The goto a stage should keep: only outcomes it has, each to a stage in the run or to the end. */
  function cleanGoto(s, stages) {
    const out = {};
    const ids = new Set(stages.map((t) => t.id));
    for (const o of outcomesFor(s)) {
      const to = s.goto?.[o.key];
      if (to === 'end' || (to && ids.has(to))) out[o.key] = to;
    }
    return out;
  }

  /** The stage named a goto or a retry points at, renamed or removed: the references follow the change. */
  function followRename(stages, old, next) {
    return stages.map((s) => {
      const goto = Object.fromEntries(Object.entries(s.goto || {}).map(([k, v]) => [k, v === old ? next : v]));
      return { ...s, goto, retryTo: s.retryTo === old ? next : s.retryTo };
    });
  }

  /** A stage id no other stage in the list uses, from a base such as the role name. */
  function uniqueId(stages, base) {
    const root = slug(base) || 'step';
    let id = root;
    for (let n = 2; stages.some((s) => s.id === id); n++) id = `${root}-${n}`;
    return id.slice(0, 41);
  }

  /** Starting points for a new workflow. The ChatDev one is a Planner-Programmer-Reviewer-Tester team with review loops, as in ChatDev's software company. */
  const TEMPLATES = {
    blank: {
      label: 'Blank: one stage to start from',
      text: 'One Engineer stage that does the task. Add stages around it.',
      stages: () => [stage({ id: 'work', role: 'Engineer', prompt: 'Complete the task. Look before you change, make the smallest change that completes it, and check your work by running the project’s tests. Call finish with what you changed.' })],
    },
    chatdev: {
      label: 'ChatDev dev team',
      text: 'A CEO plans, a Programmer writes the code, then a Reviewer and a Tester each check it and send FAIL back to the Programmer.',
      stages: () => [
        stage({ id: 'ceo', role: 'CEO', tools: 'read', prompt: 'Turn the goal into a short spec: what the feature must do, what it must not change, and the files the Programmer should touch. Do not write code. Call finish with the spec.' }),
        stage({ id: 'programmer', role: 'Programmer', tools: 'all', prompt: 'Write the code the CEO’s spec asks for, in the style of the code around it. Run the tests and fix what fails. If the Reviewer or Tester sent back problems, fix exactly those. Call finish with what you changed.' }),
        stage({ id: 'reviewer', role: 'Reviewer', tools: 'check', verdict: true, retryTo: 'programmer', maxRetries: 2, prompt: 'Review the diff (git diff HEAD) against the spec: wrong behaviour, missing error handling, code that does not fit. Start your finish summary with PASS if it is right, or FAIL followed by a numbered list of the real problems, each with its file.' }),
        stage({ id: 'tester', role: 'Tester', tools: 'check', verdict: true, retryTo: 'programmer', maxRetries: 2, prompt: 'Run the project’s tests, and try what the spec asks for as a user would. Start your finish summary with PASS if it works, or FAIL followed by exactly what failed.' }),
      ],
    },
  };

  /** Ready-made stages for the Add stage menu. A stage made from one gets a fresh id, and the rest of its settings can be changed afterward. */
  const STAGE_TEMPLATES = [
    { key: 'explorer', label: 'Explorer', text: 'Looks through the files and code the task touches, and reports what is there. Reads only.',
      stage: { id: 'explorer', role: 'Explorer', tools: 'read', prompt: 'Find the code and files this task touches, and the conventions around them. Change nothing and run nothing. Call finish with what is there, the files that matter and anything the next stage must know.' } },
    { key: 'planner', label: 'Planner', text: 'Turns the task into a numbered plan: the files to change, what changes in each and how to test it. Reads only.',
      stage: { id: 'planner', role: 'Planner', tools: 'read', effort: 'high', prompt: 'Plan the change. Read the code it touches and the conventions around it. Do not change any file. Call finish with a numbered plan: the files to change, what changes in each, how to test it, and anything ambiguous with the choice you made.' } },
    { key: 'architect', label: 'CEO / Architect', text: 'Decides the shape of the change before code is written: the parts, the interfaces and what must not change. Reads only.',
      stage: { id: 'architect', role: 'Architect', tools: 'read', effort: 'high', prompt: 'Turn the goal into a short spec: what the change must do, what it must not change, the parts it touches and the risks. Do not write code. Call finish with the spec and the reasons for it.' } },
    { key: 'programmer', label: 'Programmer', text: 'Makes the change the plan or spec asks for, runs the tests and fixes what fails. Has every tool.',
      stage: { id: 'programmer', role: 'Programmer', tools: 'all', prompt: 'Make the change the plan or spec asks for, in the style of the code around it. Run the tests and fix what fails. If a checking stage sent back problems, fix exactly those. Call finish with what you changed.' } },
    { key: 'reviewer', label: 'Reviewer', text: 'Reads the diff against the task and says PASS or FAIL. FAIL sends the work back to the stage that made it.',
      stage: { id: 'reviewer', role: 'Reviewer', tools: 'check', verdict: true, maxRetries: 2, diff: true, prompt: 'Review the diff against the task: wrong behaviour, missing error handling, code that does not fit the code around it. Start your finish summary with PASS if it is right, or FAIL followed by a numbered list of the real problems, each with its file.' } },
    { key: 'tester', label: 'Tester', text: 'Runs the tests and tries the change as a user would. Says PASS or FAIL. FAIL sends the work back to the stage that made it.',
      stage: { id: 'tester', role: 'Tester', tools: 'check', verdict: true, maxRetries: 2, prompt: 'Run the project’s tests, and try what the task asks for as a user would. Start your finish summary with PASS if it works, or FAIL followed by exactly what failed.' } },
    { key: 'security', label: 'Security check', text: 'Reads the diff for security problems such as unchecked input, secrets in code or unsafe paths. Says PASS or FAIL.',
      stage: { id: 'security', role: 'Security check', tools: 'check', effort: 'high', verdict: true, maxRetries: 1, diff: true, prompt: 'Review the diff for security problems: input that is not checked, secrets in code, unsafe commands or file paths, and weakened access checks. Start your finish summary with PASS if there is nothing real, or FAIL followed by a numbered list of the problems, each with its file.' } },
    { key: 'writer', label: 'Writer', text: 'Writes words from the text it is given, such as a summary or a message. No tools, and sent as a half-price batch.',
      stage: { id: 'writer', role: 'Writer', tools: 'none', canWait: true, model: 'anthropic/claude-sonnet-5.5', prompt: 'Write the text the task asks for from the material you are given. Call finish with the text, and say plainly anything you could not tell from the material.' } },
    { key: 'docs', label: 'Docs writer', text: 'Updates the README, docs and help text that the change affects, in the existing wording.',
      stage: { id: 'docs', role: 'Docs writer', tools: 'all', prompt: 'Update the README, docs and help text that the change affects. Match the wording already there. Do not change code. Call finish with the files you changed.' } },
    { key: 'summarizer', label: 'Summarizer', text: 'Reads what the earlier stages handed on and writes a short summary for the person: what changed, what was tested and what is left. No tools.',
      stage: { id: 'summarizer', role: 'Summarizer', tools: 'none', prompt: 'Summarize what the earlier stages did as a short list for the person: what changed, what was tested and what is left. Call finish with the summary.' } },
    { key: 'branch', label: 'Yes or no branch', text: 'Asks Jev a yes or no question about the last summary, or looks for some text in it, and sends the run one way or the other. No agent, no cost beyond Jev’s answer.',
      stage: { kind: 'branch', id: 'check', role: 'Check', tools: 'none', ask: 'Did the tests fail?' } },
    { key: 'human', label: 'Ask a person', text: 'Pauses the run and asks you a question. Pick an option or type an answer. If you do not answer in time, the default is taken.',
      stage: { kind: 'human', id: 'ask', role: 'You', tools: 'none', question: 'Should the run go ahead?', options: ['Yes', 'No'], defaultOption: 'No', timeoutMinutes: 60 } },
  ];

  /** The stage a checking stage inserted at position `at` sends FAIL to: the nearest earlier stage that does the work, else the one just before it. */
  function retryTarget(stages, at) {
    const before = stages.slice(0, at);
    const worker = before.slice().reverse().find((t) => t.tools === 'all');
    return (worker || before[before.length - 1] || {}).id || null;
  }

  /** A new stage from a template (built-in or saved), with an id unused in the list and FAIL wired up if it checks. */
  function fromTemplate(template, stages, at) {
    const over = template.stage;
    const s = stage({ ...over, retryTo: null, maxRetries: over.verdict ? over.maxRetries || 1 : 0 });
    s.id = uniqueId(stages, over.id);
    if (s.verdict) s.retryTo = retryTarget(stages, at);
    return s;
  }

  /** The stage list with stage s put at position `at`. Returns a new list. */
  function insertStage(stages, at, s) {
    const next = stages.slice();
    next.splice(at, 0, s);
    return next;
  }

  /** A saved template from a stage: its settings without its place in a run. */
  function toTemplate(s, label) {
    const { retryTo, goto, ...rest } = s;
    const text = String(s.prompt || '').replace(/\s+/g, ' ').trim();
    return { key: `u:${Date.now().toString(36)}`, label, text: text.length > 140 ? `${text.slice(0, 137)}...` : text, stage: { ...rest, maxSteps: rest.maxSteps || 0, model: rest.model || null, effort: rest.effort || null } };
  }

  /** Plain-English lines about one stage, in its place in the list. */
  function explain(stages, i) {
    const s = stages[i];
    const lines = [];
    const first = i === 0;
    const last = i === stages.length - 1;
    const after = last ? 'Its finish summary is the run’s result.' : `Its finish summary is handed to ${stages[i + 1].role}.`;
    const where = (key) => {
      const to = s.goto?.[key];
      if (!to) return `goes on to ${last ? 'the finish' : stages[i + 1].role}`;
      if (to === 'end') return 'ends the run';
      return `goes to ${stages.find((t) => t.id === to)?.role || to}`;
    };
    if (s.kind === 'branch') {
      lines.push(`${s.role} answers yes or no, without an agent: ${s.ask ? `Jev is asked “${s.ask}” about the last summary` : `it looks for “${s.contains}” in the last summary`}. Yes ${where('yes')}; no ${where('no')}.`);
      return lines;
    }
    if (s.kind === 'human') {
      const picks = s.options.length ? `The person picks one of ${s.options.map((o) => `“${o}”`).join(', ')}.` : 'The person types an answer.';
      const fallback = s.defaultOption ? `If nobody answers in ${s.timeoutMinutes} minutes, “${s.defaultOption}” is taken.` : `If nobody answers in ${s.timeoutMinutes} minutes, the run goes on with an empty answer.`;
      lines.push(`${s.role} pauses the run and asks “${s.question}”. ${picks} ${fallback}`);
      if (s.options.length) lines.push(s.options.map((o) => `“${o}” ${where(o)}.`).join(' '));
      return lines;
    }
    lines.push(`${s.role} ${TOOLS[s.tools]?.text || 'uses the tools set'}. ${first ? 'It starts the run.' : `It starts once ${stages[i - 1].role} has finished.`} ${after}`);
    if (s.verdict && s.goto?.PASS) lines.push(`If its summary starts with PASS it ${where('PASS')}.`);
    if (s.verdict) {
      const target = stages.find((t) => t.id === s.retryTo);
      lines.push(target
        ? `Its summary starts with PASS or FAIL. FAIL sends the run back to ${target.role} with what was wrong, up to ${s.maxRetries} time${s.maxRetries === 1 ? '' : 's'}; after that the run stops for a person to look.`
        : 'Its summary starts with PASS or FAIL, but no stage is set to go back to: pick one under Retry.');
    }
    if (s.canWait) lines.push(`It is one request with no tools, sent as a half-price batch that can take up to ${s.maxWaitMinutes} minutes to come back.${s.model ? '' : ' It needs a model for the batch.'}`);
    if (s.model) lines.push(`It uses the model ${s.model}, whatever routing the run has.`);
    if (s.effort) lines.push(`Effort is set to ${EFFORTS.find((e) => e.value === s.effort)?.label.toLowerCase() || s.effort}.`);
    if (s.maxSteps) lines.push(`It may make at most ${s.maxSteps} model calls.`);
    if (s.diff) lines.push('It is given the working diff, so it can judge the changes directly.');
    return lines;
  }

  /** Renaming a stage also updates the retry lines and goto choices that name it. */
  function renameStage(stages, i, newId) {
    const old = stages[i].id;
    return followRename(stages.map((s, k) => (k === i ? { ...s, id: newId } : s)), old, newId);
  }

  /** The list without stage i, with every goto and retry that pointed at it cleared. */
  function dropStage(stages, i) {
    const old = stages[i].id;
    const rest = stages.filter((_, k) => k !== i).map((s) => {
      const goto = Object.fromEntries(Object.entries(s.goto || {}).filter(([, v]) => v !== old));
      return { ...s, goto, retryTo: s.retryTo === old ? null : s.retryTo };
    });
    return rest;
  }

  /** The stages a Verifier may send work back to: itself or one before it. */
  function retryChoices(stages, i) {
    return stages.slice(0, Math.max(0, i) + 1);
  }

  /** The stage list with stage i moved one place: dir -1 (earlier) or +1 (later). Returns a new list. */
  function moveStage(stages, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return stages;
    const next = stages.slice();
    [next[i], next[j]] = [next[j], next[i]];
    // a retry that pointed at a stage it now sits behind would no longer go back, so it is cleared
    return next.map((s, k) => (s.retryTo && !next.slice(0, k).some((t) => t.id === s.retryTo) ? { ...s, retryTo: null } : s));
  }

  /** Problems that would stop the file from loading, in words for the page. Mirrors utils/workflows.js. */
  function problems(w) {
    const out = [];
    if (!ID_RE.test(String(w.id || ''))) out.push('The workflow id must be lowercase letters, digits and dashes.');
    if (!String(w.name || '').trim()) out.push('Give the workflow a name.');
    if (!w.stages.length) out.push('A workflow needs at least one stage.');
    const seen = new Set();
    w.stages.forEach((s, i) => {
      const label = s.role || `Stage ${i + 1}`;
      if (!String(s.id || '').trim()) out.push(`${label}: give the stage an id.`);
      else if (seen.has(s.id)) out.push(`${label}: the id ${s.id} is used by another stage.`);
      seen.add(s.id);
      if (!String(s.role || '').trim()) out.push(`Stage ${i + 1}: give it a role name.`);
      if (!isAgent(s) ? false : !String(s.prompt || '').trim()) out.push(`${label}: write what the stage should do.`);
      if (s.kind === 'branch' && Boolean(s.ask) === Boolean(s.contains)) out.push(`${label}: a yes or no stage needs either a question for Jev or some text to look for, not both.`);
      if (s.kind === 'human') {
        if (!String(s.question || '').trim()) out.push(`${label}: write the question for the person.`);
        if (s.options.length && s.defaultOption && !s.options.includes(s.defaultOption)) out.push(`${label}: the default answer must be one of its options.`);
      }
      for (const [key, to] of Object.entries(s.goto || {})) {
        if (!outcomesFor(s).some((o) => o.key === key)) out.push(`${label}: “${key}” is not an outcome of this stage.`);
        else if (to !== 'end' && !w.stages.some((t) => t.id === to)) out.push(`${label}: the stage it goes to for ${key} is gone.`);
      }
      if (s.canWait && !s.model) out.push(`${label}: a batch stage needs a model.`);
      if (s.retryTo && !retryChoices(w.stages, i).some((t) => t.id === s.retryTo)) out.push(`${label}: pick this stage or an earlier one to send FAIL back to.`);
      if (s.retryTo && !s.verdict) out.push(`${label}: only a stage that says PASS or FAIL can send work back.`);
    });
    return out;
  }

  const api = { TOOLS, EFFORTS, TEMPLATES, STAGE_TEMPLATES, KIND_NAMES, isAgent, retryTarget, fromTemplate, insertStage, toTemplate, stage, uniqueId, slug, explain, retryChoices, moveStage, renameStage, dropStage, outcomesFor, cleanGoto, problems, ID_RE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WorkflowsModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
