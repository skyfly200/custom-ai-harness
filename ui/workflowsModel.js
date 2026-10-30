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
    return { id: 'step', role: 'Step', tools: 'all', prompt: '', effort: null, model: null, verdict: false, retryTo: null, maxRetries: 0, maxSteps: 0, canWait: false, maxWaitMinutes: 120, diff: false, ...over };
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

  /** Plain-English lines about one stage, in its place in the list. */
  function explain(stages, i) {
    const s = stages[i];
    const lines = [];
    const first = i === 0;
    const last = i === stages.length - 1;
    const after = last ? 'Its finish summary is the run’s result.' : `Its finish summary is handed to ${stages[i + 1].role}.`;
    lines.push(`${s.role} ${TOOLS[s.tools]?.text || 'uses the tools set'}. ${first ? 'It starts the run.' : `It starts once ${stages[i - 1].role} has finished.`} ${after}`);
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

  /** Renaming a stage also updates the retry lines that name it. */
  function renameStage(stages, i, newId) {
    const old = stages[i].id;
    return stages.map((s, k) => (k === i ? { ...s, id: newId } : s.retryTo === old ? { ...s, retryTo: newId } : s));
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
      if (!String(s.prompt || '').trim()) out.push(`${label}: write what the stage should do.`);
      if (s.canWait && !s.model) out.push(`${label}: a batch stage needs a model.`);
      if (s.retryTo && !retryChoices(w.stages, i).some((t) => t.id === s.retryTo)) out.push(`${label}: pick this stage or an earlier one to send FAIL back to.`);
      if (s.retryTo && !s.verdict) out.push(`${label}: only a stage that says PASS or FAIL can send work back.`);
    });
    return out;
  }

  const api = { TOOLS, EFFORTS, TEMPLATES, stage, uniqueId, slug, explain, retryChoices, moveStage, renameStage, problems, ID_RE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WorkflowsModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
