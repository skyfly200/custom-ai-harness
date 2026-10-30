// The run page's helpers that need no DOM: the plain-English status and summary of a run, the
// trace filter, and the workflow explanations shown when starting a run.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RunView = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const ACTIVE = new Set(['queued', 'running', 'waiting']);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const first = (s) => String(s || '').split('\n')[0].trim();
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  // an exit code other than 0, a timeout, or a tool that said "error"
  function isError(e) {
    if (e.type === 'result') return /^(exit code (?!0\b)-?\d+|timed out|error)/i.test(String(e.text || '').trim());
    if (e.type === 'approval') return e.allowed === false;
    return false;
  }

  /** The files named in a `git diff --stat` summary line, or how many were touched. */
  function filesChanged(diffStat) {
    const m = /(\d+) files? changed/.exec(String(diffStat || ''));
    return m ? Number(m[1]) : 0;
  }

  /** What the agent is doing right now, in one short line. */
  function quickLine(run) {
    const ev = run.events || [];
    if (run.status === 'queued') return 'Waiting for its turn to start.';
    if (run.status === 'waiting' || run.pending) return `Waiting for you to allow or decline: ${cut(first(run.pending?.text), 80) || 'a risky step'}.`;
    if (ACTIVE.has(run.status)) {
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i], a = e.args || {};
        // what the agent said it is doing beats a description made from the tool's arguments
        if (e.type === 'tool' && e.why) return cut(first(e.why), 100);
        if (e.type === 'tool' && e.name === 'run_command') return `Running ${cut(first(a.command), 80)}`;
        if (e.type === 'tool' && e.name === 'read_file') return `Reading ${cut(first(a.path), 80)}`;
        if (e.type === 'tool' && (e.name === 'write_file' || e.name === 'edit_file')) return `Editing ${cut(first(a.path), 80)}`;
        if (e.type === 'tool' && e.name === 'list_files') return `Looking around ${cut(first(a.path) || 'the repo', 80)}`;
        if (e.type === 'stage') return cut(first(e.text), 100);
        if (e.type === 'model' && e.text) return `Thinking: ${cut(first(e.text), 90)}`;
      }
      return 'Starting up.';
    }
    if (run.status === 'done') return run.plan ? 'Finished writing a plan. Nothing was changed.' : run.result?.commit ? 'Finished. The work is saved on its branch.' : 'Finished. Nothing was changed.';
    if (run.status === 'incomplete') return run.outOfBudget ? 'Stopped at its cost limit.' : run.outOfSteps ? 'Ran out of steps before it finished.' : 'Ran out of time before it finished.';
    if (run.status === 'failed') return `Failed: ${cut(first(run.error) || 'see the trace', 100)}`;
    if (run.status === 'stopped') return 'Stopped by you.';
    if (run.status === 'interrupted') return `Interrupted: ${{ restart: 'the runner restarted', shutdown: 'the runner was shutting down', sandbox: 'the cloud sandbox ended' }[run.interrupted?.reason] || 'it was cut off'}.`;
    return run.status;
  }

  /** A few plain sentences about the whole run, from what the run record already holds. */
  function summarize(run, workers = []) {
    const ev = run.events || [];
    const out = [];
    const tools = ev.filter((e) => e.type === 'tool');
    const cmds = tools.filter((e) => e.name === 'run_command').length;
    const edits = new Set(tools.filter((e) => e.name === 'write_file' || e.name === 'edit_file').map((e) => (e.args || {}).path)).size;
    const reads = tools.filter((e) => e.name === 'read_file').length;
    const errors = ev.filter(isError).length;
    const stages = ev.filter((e) => e.type === 'stage').length;

    const verb = ACTIVE.has(run.status) ? 'So far it has' : 'It';
    const did = [];
    if (reads) did.push(`read ${plural(reads, 'file')}`);
    if (edits) did.push(`changed ${plural(edits, 'file')}`);
    if (cmds) did.push(`run ${plural(cmds, 'command')}`);
    out.push(did.length ? `${verb} ${did.length > 1 ? `${did.slice(0, -1).join(', ')} and ${did[did.length - 1]}` : did[0]} in ${plural(run.steps || 0, 'step')}.` : `${verb === 'It' ? 'It took' : 'It has taken'} ${plural(run.steps || 0, 'step')}${tools.length ? '' : ' and has not touched the repo yet'}.`);
    if (run.workflowName && stages) out.push(`Following “${run.workflowName}”${run.stage ? `, now in ${run.stage}` : ''}.`);
    if (workers.length) {
      const done = workers.filter((w) => w.status === 'done').length;
      out.push(`${plural(workers.length, 'worker')} on separate branches; ${done} finished.`);
    }
    if (run.resumedAuto) out.push(`Resumed automatically (attempt ${run.resumedAuto.attempt} of ${run.resumedAuto.of}) after it was interrupted.`);
    if (run.warning) out.push(`Warning: ${first(run.warning.text)}`);
    if (errors) out.push(`${plural(errors, 'step')} hit a problem${run.status === 'done' ? ', but it carried on' : ''}.`);
    const r = run.result;
    if (r && !run.plan) {
      const n = filesChanged(r.diffStat);
      out.push(n ? `The result changes ${plural(n, 'file')}${r.tests ? (r.tests.passed ? ' and the tests pass' : ' and the tests fail') : ''}.` : 'The result changes no files.');
    }
    if (run.error) out.push(`It stopped with an error: ${cut(first(run.error), 140)}`);
    else if (r?.summary) out.push(`Its own report: ${cut(first(r.summary), 200)}`);
    return out.join(' ');
  }

  /** Events with the stage and tool each belongs to (a result belongs to the tool before it). */
  function annotate(events) {
    let stage = '', tool = '';
    return (events || []).map((e, i) => {
      if (e.type === 'stage') stage = String(e.text || '');
      if (e.type === 'tool') tool = e.name || '';
      const item = { e, i, stage, tool: e.type === 'tool' || e.type === 'result' ? tool : '' };
      if (e.type === 'result') tool = '';
      return item;
    });
  }

  const GROUPS = { model: ['model'], tool: ['tool', 'result'], stage: ['stage', 'plan', 'note', 'warning'], approval: ['approval', 'approval_needed'] };

  /** f = { type: 'all'|group, tool, stage, errors } */
  function filterEvents(items, f = {}) {
    return items.filter(({ e, stage, tool }) => {
      if (f.type && f.type !== 'all' && !(GROUPS[f.type] || []).includes(e.type)) return false;
      if (f.tool && tool !== f.tool) return false;
      if (f.stage && stage !== f.stage) return false;
      if (f.errors && !isError(e)) return false;
      return true;
    });
  }

  /** The words a search looks in for one event. */
  function searchText(e) {
    return [e.text, e.name, e.model, e.args && (e.args.command || e.args.path)].filter(Boolean).join(' ');
  }

  // What each way of working means, for someone choosing one. `feel` is the rough cost and time.
  const HELP = {
    auto: { what: 'Jev reads your prompt and picks the way of working that fits.', use: 'When you are not sure. You can see its pick, and change it, before you start.', feel: 'Adds a second or two before it starts.' },
    general: { what: 'One agent does the task start to finish, with no separate checking step.', use: 'Small or unusual tasks that fit no other recipe.', feel: 'Cheapest and quickest of the ones that change code.' },
    'quick-answer': { what: 'One agent reads the code and answers. It cannot change anything.', use: 'A question about how something works or where something lives.', feel: 'Very cheap; usually under a minute or two.' },
    research: { what: 'A reader digs through the code, then a writer turns it into a report. Nothing is changed.', use: 'A bigger question that needs reading across many files, or comparing approaches.', feel: 'Cheap to moderate; a few minutes.' },
    review: { what: 'A reviewer checks the code and a skeptic then tries to knock down what it found, so the report is trustworthy. Nothing is changed.', use: 'Reviewing a branch, recent changes or a part of the code for problems.', feel: 'Moderate; the second pass roughly doubles it.' },
    'fix-bug': { what: 'An investigator finds the real cause first, an implementer makes the smallest fix, and a verifier runs the tests to check it.', use: 'A failing test, an error message or something that should work but does not.', feel: 'Moderate; three steps, a few minutes to tens of minutes.' },
    'build-feature': { what: 'A planner reads the code and writes down a plan, an implementer builds it, and a verifier checks the result.', use: 'New behaviour: an option, an endpoint, a page, spread over a few files.', feel: 'Moderate to dear; planning pays off on bigger changes.' },
    'build-audit': { what: 'An implementer builds the change, then an auditor reviews it and sends problems back until it is clean.', use: 'A change you want a second pair of eyes on before you accept it.', feel: 'Dearer and slower than a plain build, safer.' },
    refactor: { what: 'A planner maps the clean-up, an implementer does it without changing behaviour, and a verifier checks that nothing broke.', use: 'Renaming, restructuring or simplifying code.', feel: 'Moderate; the checks make it steady, not fast.' },
    'audit-refactor': { what: 'A refactorer works and an auditor keeps checking, round after round, until nothing is left to fix.', use: 'A large or risky clean-up across many files.', feel: 'The dearest and slowest single-branch option.' },
    'change-app': { what: 'Changes a registered app from inside it, then a verifier runs its tests so you can preview and ship it.', use: 'Ask for a button, layout, filter or wording change in one of your apps.', feel: 'Moderate; ends with a live preview.' },
    swarm: { what: 'A planner splits the goal into parts, several agents work at once on their own branches, the branches are merged and a reviewer checks the whole.', use: 'A big goal with parts that are mostly independent.', feel: 'Dearest: several agents paid at once, but quicker than doing the parts in turn.' },
    chatdev: { what: 'Hands the goal to ChatDev, an outside team of role-playing agents, in a cloud sandbox with its models routed through this harness.', use: 'Building something from scratch. Needs ChatDev set up on the server.', feel: 'Slow and dear; experimental.' },
  };

  /** Help for a workflow object ({id, name, when, stages}) or a built-in id; falls back to what the recipe file says. */
  function help(w) {
    const id = typeof w === 'string' ? w : w.id;
    const known = HELP[id];
    if (known) return known;
    const stages = (w.stages || []).map((s) => s.role).join(' → ');
    return { what: stages ? `Steps: ${stages}.` : 'A custom recipe.', use: w.when ? `Fits ${w.when}.` : 'See the recipe file.', feel: '' };
  }

  return { isError, filesChanged, quickLine, summarize, annotate, filterEvents, searchText, help, HELP };
}));
