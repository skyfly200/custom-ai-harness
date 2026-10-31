// Workflows page: list, edit and save the recipes in workflows/*.json as a row of stage boxes.
// The rules for a stage, its words and its checks are in workflowsModel.js; this file draws and wires them.
(function () {
  'use strict';
  const M = window.WorkflowsModel;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const SHORT_TOOLS = { read: 'reads', check: 'reads and runs', all: 'all tools', none: 'no tools' };

  let list = [];       // the workflows on disk: { id, name, when, fallback, stages }
  let wf = null;       // the one being edited, in the editor's shape
  let savedJson = null; // what the file holds, to tell whether there are unsaved changes (null: a new one)
  let sel = 0;         // index of the stage being edited
  let isNew = false;   // not saved yet
  let models = [];     // Gateway model names, for the Model box

  const dirty = () => !!wf && JSON.stringify(wf) !== savedJson;
  const msg = (text, cls) => { $('msg').textContent = text; $('msg').className = `note ${cls || ''}`; };

  // Turns a file's stage (which omits defaults) into the editor's full shape
  function hydrate(file) {
    return {
      id: file.id,
      name: file.name || file.id,
      when: file.when || '',
      fallback: !!file.fallback,
      stages: (file.stages || []).map((s) => M.stage({ ...s, effort: s.effort || null, model: s.model || null })),
    };
  }
  // The body the server takes: the same fields, with empty effort and model left out
  const toBody = (w) => ({
    ...w,
    stages: w.stages.map((s) => ({ ...s, effort: s.effort || null, model: (s.model || '').trim() || null, retryTo: M.isAgent(s) && s.verdict ? s.retryTo : null, maxRetries: M.isAgent(s) && s.verdict ? s.maxRetries : 0, goto: M.cleanGoto(s, w.stages) })),
  });

  // ---- the workflow list ----
  async function loadList(selectId) {
    const res = await fetch('api/workflows', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    list = body.workflows || [];
    if (body.problems?.length) msg(`${body.problems.length} workflow file${body.problems.length === 1 ? ' is' : 's are'} broken and left out: ${body.problems.join('; ')}`, 'bad');
    drawList(selectId);
  }
  function drawList(selectId) {
    const opts = list.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}${w.fallback ? ' (fallback)' : ''}</option>`);
    if (isNew && wf) opts.push(`<option value="${esc(wf.id)}">${esc(wf.name || wf.id)} (new, not saved)</option>`);
    $('wfSel').innerHTML = opts.join('');
    $('wfSel').value = selectId || (wf ? wf.id : list[0]?.id || '');
  }

  async function open(id) {
    if (dirty() && !(await window.ui.confirm('Discard the changes to this workflow?', { ok: 'Discard', danger: true }))) {
      $('wfSel').value = wf.id;
      return;
    }
    const res = await fetch(`api/workflows/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!res.ok) { msg(`Could not open it (HTTP ${res.status})`, 'bad'); return; }
    const file = await res.json();
    wf = hydrate(file);
    savedJson = JSON.stringify(wf);
    sel = 0;
    drawAll();
    msg('');
  }

  // ---- the canvas: one box per stage, arrows between, dashed arcs for FAIL loops ----
  function drawCanvas() {
    const track = $('track');
    const parts = ['<span class="wf-end">Start</span>'];
    wf.stages.forEach((s, i) => {
      if (i) parts.push('<span class="wf-arrow" aria-hidden="true">→</span>');
      const chips = [];
      if (s.kind === 'branch') chips.push(s.ask ? 'Jev yes / no' : `looks for “${s.contains}”`);
      else if (s.kind === 'human') chips.push(s.options.length ? `asks: ${s.options.join(' / ')}` : 'asks a person');
      else {
        chips.push(SHORT_TOOLS[s.tools]);
        if (s.effort) chips.push(`${s.effort} thinking`);
        if (s.model) chips.push(s.model);
        if (s.canWait) chips.push('batch');
        if (s.diff) chips.push('diff');
        if (s.verdict) chips.push('PASS / FAIL');
      }
      for (const o of M.outcomesFor(s)) {
        const to = s.goto?.[o.key];
        if (to) chips.push(`${o.label} → ${to === 'end' ? 'finish' : (wf.stages.find((t) => t.id === to)?.role || to)}`);
      }
      parts.push(`<button class="wf-node${i === sel ? ' on' : ''}${s.verdict || s.kind !== 'agent' ? ' check' : ''}" data-i="${i}" aria-pressed="${i === sel}" data-hint="Edit this stage">
        <span class="wf-num">${i + 1}</span><b>${esc(s.role)}</b><small>${esc(s.id)}</small>
        <span class="chips">${chips.map((c) => `<i>${esc(c)}</i>`).join('')}</span></button>`);
    });
    parts.push('<span class="wf-end">Finish</span>');
    track.querySelectorAll('.wf-end, .wf-arrow, .wf-node').forEach((n) => n.remove());
    track.insertAdjacentHTML('beforeend', parts.join(''));
    drawArcs();
    $('canvasHint').textContent = wf.stages.length === 1
      ? 'Add more stages with the Duplicate button, then arrange them with Earlier and Later.'
      : 'Arrows show the order the run takes. A dashed arc is a FAIL, or a yes, no or person’s answer, that sends the run back. A choice that skips ahead is shown on its box.';
  }

  function drawArcs() {
    const track = $('track');
    const svg = $('arcs');
    const nodes = [...track.querySelectorAll('.wf-node')];
    const w = track.scrollWidth;
    const h = track.scrollHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.querySelectorAll('.arc, .arc-label').forEach((n) => n.remove());
    // a backward arc: each FAIL retry, and each goto that sends the run to an earlier stage, labelled with its outcome
    const back = [];
    wf.stages.forEach((s, i) => {
      if (s.verdict && M.isAgent(s) && s.retryTo && !s.goto?.FAIL) {
        const j = wf.stages.findIndex((t) => t.id === s.retryTo);
        if (j >= 0 && j < i) back.push({ from: i, to: j, label: 'FAIL' });
      }
      for (const [key, to] of Object.entries(s.goto || {})) {
        const j = wf.stages.findIndex((t) => t.id === to);
        if (j >= 0 && j < i) back.push({ from: i, to: j, label: key, goto: true });
      }
    });
    back.forEach((arc, k) => {
      const a = nodes[arc.from]; const b = nodes[arc.to];
      if (!a || !b) return;
      const x1 = a.offsetLeft + a.offsetWidth / 2;
      const x2 = b.offsetLeft + b.offsetWidth / 2;
      const top = a.offsetTop;
      const lift = 34 + k * 18;
      const d = `M${x1} ${top - 2} C${x1} ${top - lift - 26}, ${x2} ${top - lift - 26}, ${x2} ${b.offsetTop - 4}`;
      // a cubic curve with both ends level reaches 3/4 of its control height at the top, where the label sits
      const apex = top - 0.75 * (lift + 26);
      svg.insertAdjacentHTML('beforeend', `<path class="arc${arc.goto ? ' arc-goto' : ''}" d="${d}" marker-end="url(#arrowhead)"></path>
        <text class="arc-label${arc.goto ? ' arc-label-goto' : ''}" x="${(x1 + x2) / 2}" y="${apex - 6}">${esc(arc.label)}</text>`);
    });
  }

  // ---- the editor for the selected stage ----
  function fillEffort() {
    $('fEffort').innerHTML = M.EFFORTS.map((e) => `<option value="${e.value}" title="${esc(e.text)}">${esc(e.label)}</option>`).join('');
  }
  function fillRetry(s, i) {
    const choices = M.retryChoices(wf.stages, i);
    $('fRetry').innerHTML = choices.length
      ? choices.map((t) => `<option value="${esc(t.id)}">${esc(t.role)} (${esc(t.id)})</option>`).join('')
      : '<option value="">No earlier stage yet</option>';
    // a new check goes back to the stage before it; the first stage can only go back to itself
    const before = choices[Math.max(0, choices.length - 2)];
    $('fRetry').value = s.retryTo && choices.some((t) => t.id === s.retryTo) ? s.retryTo : (before?.id || '');
  }
  // The Where each outcome goes rows: one select per outcome the stage has, listing the stages and the end
  function fillGoto(s, i) {
    const outcomes = M.outcomesFor(s);
    $('gotoBox').hidden = !outcomes.length;
    $('gotoRows').innerHTML = outcomes.map((o) => {
      const cur = s.goto?.[o.key] || '';
      const choices = [`<option value="">The next stage in the list</option>`,
        ...wf.stages.map((t) => `<option value="${esc(t.id)}">${esc(t.role)} (${esc(t.id)})</option>`),
        '<option value="end">Finish the run here</option>'];
      return `<div class="wf-goto-row"><span><b>${esc(o.label)}</b></span>
        <select data-goto="${esc(o.key)}" aria-label="Where ${esc(o.label)} goes">${choices.join('').replace(`value="${esc(cur)}"`, `value="${esc(cur)}" selected`)}</select></div>`;
    }).join('');
  }
  function fillKindFields(s) {
    $('fKind').value = s.kind || 'agent';
    $('fBy').value = s.contains ? 'contains' : 'ask';
    $('fAsk').value = s.ask || '';
    $('fContains').value = s.contains || '';
    $('fQuestion').value = s.question || '';
    $('fOptions').value = (s.options || []).join('\n');
    fillDefaultChoices(s);
    $('fDefaultText').value = s.options?.length ? '' : (s.defaultOption || '');
    $('fTimeout').value = s.timeoutMinutes || 60;
  }
  // The default answer choices follow the options, so a changed option list is never offered a stale default
  function fillDefaultChoices(s) {
    $('fDefault').innerHTML = (s.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    $('fDefault').value = s.defaultOption || '';
  }
  function loadForm() {
    const s = wf.stages[sel];
    if (!s) return;
    $('editTitle').textContent = `Stage ${sel + 1}: ${s.role}`;
    $('fRole').value = s.role;
    $('fId').value = s.id;
    fillKindFields(s);
    $('fPrompt').value = s.prompt;
    $('fTools').value = s.tools;
    $('fEffort').value = s.effort || '';
    $('fModel').value = s.model || '';
    $('fMaxSteps').value = s.maxSteps;
    $('fVerdict').checked = s.verdict;
    $('fRetries').value = s.maxRetries;
    $('fBatch').checked = s.canWait;
    $('fWait').value = s.maxWaitMinutes;
    $('fDiff').checked = s.diff;
    fillRetry(s, sel);
    $('stEarlier').disabled = sel === 0;
    $('stLater').disabled = sel === wf.stages.length - 1;
    $('stDelete').disabled = wf.stages.length === 1;
    fillGoto(s, sel);
    showConditional();
  }
  function showConditional() {
    const s = wf.stages[sel];
    const kind = s.kind || 'agent';
    for (const el of document.querySelectorAll('[data-only]')) el.hidden = el.dataset.only !== kind;
    $('fAsk').closest('label').hidden = $('fBy').value !== 'ask';
    $('fContains').closest('label').hidden = $('fBy').value !== 'contains';
    $('fDefault').closest('label').hidden = !(s.options?.length);
    $('fDefaultText').closest('label').hidden = Boolean(s.options?.length);
    $('verdictBox').hidden = !(M.isAgent(s) && s.verdict);
    $('fWait').closest('label').hidden = !s.canWait;
    $('explain').replaceChildren(...M.explain(wf.stages, sel).map((t) => Object.assign(document.createElement('li'), { textContent: t })));
    const problems = M.problems(wf).filter((p) => p.startsWith(s.role) || p.startsWith(`Stage ${sel + 1}`));
    $('editor').classList.toggle('needs', problems.length > 0);
  }
  function readForm() {
    const s = wf.stages[sel];
    const prevId = s.id;
    const id = $('fId').value.trim();
    s.role = $('fRole').value;
    s.kind = $('fKind').value;
    s.prompt = $('fPrompt').value;
    s.ask = s.kind === 'branch' && $('fBy').value === 'ask' ? ($('fAsk').value.trim() || null) : null;
    s.contains = s.kind === 'branch' && $('fBy').value === 'contains' ? ($('fContains').value.trim() || null) : null;
    s.question = $('fQuestion').value.trim();
    s.options = $('fOptions').value.split('\n').map((o) => o.trim()).filter(Boolean).filter((o, k, all) => all.indexOf(o) === k).slice(0, 6);
    s.defaultOption = s.options.length ? ($('fDefault').value || s.options[0]) : ($('fDefaultText').value.trim() || null);
    s.timeoutMinutes = Math.max(1, Math.min(1440, Math.floor(Number($('fTimeout').value)) || 60));
    s.goto = {};
    for (const sel2 of document.querySelectorAll('[data-goto]')) if (sel2.value) s.goto[sel2.dataset.goto] = sel2.value;
    s.tools = $('fTools').value;
    s.effort = $('fEffort').value || null;
    s.model = $('fModel').value.trim() || null;
    s.maxSteps = Math.max(0, Math.min(10000, Math.floor(Number($('fMaxSteps').value)) || 0));
    s.verdict = $('fVerdict').checked;
    s.retryTo = s.verdict && M.isAgent(s) ? ($('fRetry').value || null) : null;
    s.maxRetries = s.verdict && M.isAgent(s) ? Math.max(0, Math.min(5, Math.floor(Number($('fRetries').value)) || 0)) : 0;
    s.canWait = $('fBatch').checked;
    s.maxWaitMinutes = Math.max(1, Math.min(1440, Math.floor(Number($('fWait').value)) || 120));
    s.diff = $('fDiff').checked;
    if (id !== prevId) wf.stages = M.renameStage(wf.stages, sel, id);
    else s.id = prevId;
  }
  // Redraws the boxes and the Retry list when the stage list or a stage's id or role changes; leaves the fields alone so typing keeps its place
  function refresh() {
    drawCanvas();
    showConditional();
    fillRetry(wf.stages[sel], sel);
    fillGoto(wf.stages[sel], sel);
    $('wfSave').disabled = !dirty();
    $('wfDiscard').disabled = !dirty();
    const problems = M.problems(wf);
    $('problemList').replaceChildren(...problems.map((p) => Object.assign(document.createElement('li'), { textContent: p })));
    $('problems').hidden = !problems.length;
    if (isNew) drawList(wf.id);
  }
  function drawAll() {
    $('wfName').value = wf.name;
    $('wfWhen').value = wf.when;
    $('wfFallback').checked = wf.fallback;
    $('wfId').textContent = `File: workflows/${wf.id}.json`;
    drawList(wf.id);
    drawCanvas();
    loadForm();
    refresh();
  }
  function select(i) {
    readForm();
    sel = i;
    drawCanvas();
    loadForm();
    refresh();
  }
  function mutate(fn) {
    readForm();
    fn();
    sel = Math.min(sel, wf.stages.length - 1);
    drawCanvas();
    loadForm();
    refresh();
  }

  // ---- wiring ----
  $('track').addEventListener('click', (e) => {
    const node = e.target.closest('.wf-node');
    if (node) select(Number(node.dataset.i));
  });
  for (const id of ['fRole', 'fId', 'fPrompt', 'fModel', 'fMaxSteps', 'fRetries', 'fWait', 'fAsk', 'fContains', 'fQuestion', 'fDefaultText', 'fTimeout']) {
    $(id).addEventListener('input', () => { readForm(); refresh(); });
  }
  $('fOptions').addEventListener('input', () => { readForm(); fillDefaultChoices(wf.stages[sel]); refresh(); });
  for (const id of ['fTools', 'fEffort', 'fRetry', 'fVerdict', 'fBatch', 'fDiff', 'fBy', 'fDefault']) {
    $(id).addEventListener('change', () => { readForm(); refresh(); loadForm(); });
  }
  $('gotoRows').addEventListener('change', () => { readForm(); refresh(); });
  // Changing the kind of a stage gives the new kind the fields it needs, so the form is never empty
  $('fKind').addEventListener('change', () => {
    readForm();
    const s = wf.stages[sel];
    if (s.kind === 'branch' && !s.ask && !s.contains) s.ask = 'Did the last stage find a problem?';
    if (s.kind === 'human' && !s.question) s.question = 'Should the run go ahead?';
    if (s.kind === 'agent' && !String(s.prompt || '').trim()) s.prompt = 'Complete the task. Call finish with what you did.';
    if (s.kind !== 'agent') s.retryTo = null;
    refresh();
    loadForm();
  });
  $('wfName').addEventListener('input', () => { wf.name = $('wfName').value; refresh(); });
  $('wfWhen').addEventListener('input', () => { wf.when = $('wfWhen').value; refresh(); });
  $('wfFallback').addEventListener('change', () => {
    wf.fallback = $('wfFallback').checked;
    refresh();
  });
  $('stEarlier').addEventListener('click', () => mutate(() => { wf.stages = M.moveStage(wf.stages, sel, -1); sel -= 1; }));
  $('stLater').addEventListener('click', () => mutate(() => { wf.stages = M.moveStage(wf.stages, sel, 1); sel += 1; }));
  $('stCopy').addEventListener('click', () => mutate(() => {
    const at = sel + 1;
    const base = wf.stages[sel];
    const copy = { ...clone(base), id: M.uniqueId(wf.stages, base.id), role: `${base.role} 2`, retryTo: null, goto: {} };
    wf.stages.splice(at, 0, copy);
    sel = at;
  }));
  $('stDelete').addEventListener('click', async () => {
    const s = wf.stages[sel];
    if (!(await window.ui.confirm(`Remove the ${s.role} stage?`, { ok: 'Remove', danger: true }))) return;
    mutate(() => { wf.stages = M.dropStage(wf.stages, sel); });
  });
  $('wfSel').addEventListener('change', () => open($('wfSel').value));
  window.addEventListener('resize', () => drawArcs());
  window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });

  $('wfDiscard').addEventListener('click', async () => {
    if (!isNew) return open(wf.id);
    isNew = false;
    await loadList();
    if (list.length) return open(list[0].id);
    wf = null;
    return null;
  });

  $('wfSave').addEventListener('click', async () => {
    readForm();
    const problems = M.problems(wf);
    if (problems.length) {
      refresh();
      window.ui.toast('Fix the problems listed above before saving', { kind: 'error' });
      return;
    }
    const body = toBody(wf);
    const url = isNew ? 'api/workflows' : `api/workflows/${encodeURIComponent(wf.id)}`;
    const res = await fetch(url, { method: isNew ? 'POST' : 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg(out.error || `Could not save (HTTP ${res.status})`, 'bad');
      window.ui.toast(out.error || 'Could not save', { kind: 'error' });
      return;
    }
    isNew = false;
    wf = hydrate(out);
    savedJson = JSON.stringify(wf);
    msg(`Saved ${wf.name}. The next run uses it.`, 'ok');
    await loadList(wf.id);
    drawAll();
  });

  // New workflow dialog
  function fillStarts() {
    const starts = Object.entries(M.TEMPLATES).map(([key, t]) => ({ key: `t:${key}`, label: t.label, text: t.text }));
    for (const w of list) starts.push({ key: `w:${w.id}`, label: `Copy of ${w.name}`, text: w.when || 'Copies its stages, which you can then change.' });
    $('newStarts').innerHTML = starts.map((s, i) => `<label class="wf-start-opt"><input type="radio" name="start" value="${esc(s.key)}"${i === 0 ? ' checked' : ''}>
      <span><b>${esc(s.label)}</b><small>${esc(s.text)}</small></span></label>`).join('');
  }
  $('wfNew').addEventListener('click', async () => {
    if (dirty() && !(await window.ui.confirm('Discard the changes to this workflow?', { ok: 'Discard', danger: true }))) return;
    $('newName').value = '';
    $('newId').value = '';
    $('newErr').hidden = true;
    fillStarts();
    $('newDialog').showModal();
    $('newName').focus();
  });
  $('newName').addEventListener('input', () => { if (!$('newId').dataset.edited) $('newId').value = M.slug($('newName').value); });
  $('newId').addEventListener('input', () => { $('newId').dataset.edited = '1'; });
  $('newCancel').addEventListener('click', () => $('newDialog').close());
  $('newForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('newId').value.trim();
    const name = $('newName').value.trim();
    if (!M.ID_RE.test(id)) { $('newErr').textContent = 'The stage id must be lowercase letters, digits and dashes.'; $('newErr').hidden = false; return; }
    if (list.some((w) => w.id === id)) { $('newErr').textContent = `A workflow named ${id} already exists.`; $('newErr').hidden = false; return; }
    const pick = document.querySelector('input[name="start"]:checked')?.value || 't:blank';
    const [kind, key] = [pick.slice(0, 1), pick.slice(2)];
    $('newDialog').close();
    if (kind === 't') return openNew({ id, name, stages: M.TEMPLATES[key].stages(), when: '' });
    // a copy takes the other workflow's stages, so fetch them in full
    fetch(`api/workflows/${encodeURIComponent(key)}`, { credentials: 'same-origin' })
      .then((r) => r.json()).then((file) => openNew({ id, name, stages: hydrate(file).stages, when: '' }))
      .catch((err) => msg(`Could not copy it: ${err.message}`, 'bad'));
  });
  function openNew(w) {
    wf = { ...w, fallback: false };
    isNew = true;
    savedJson = null;
    sel = 0;
    drawAll();
    msg('New workflow: press Save to write it.');
  }

  // Add stage: ready-made stages, plus the ones the person saved in this browser
  const TPL_KEY = 'harness-stage-templates';
  function savedTemplates() {
    try {
      const list = JSON.parse(localStorage.getItem(TPL_KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => t && t.stage && t.label) : [];
    } catch { return []; }
  }
  function storeTemplates(list) {
    try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); return true; } catch { return false; }
  }
  function openStageDialog() {
    readForm();
    const all = [...M.STAGE_TEMPLATES, ...savedTemplates()];
    $('stageChoices').innerHTML = all.map((t, i) => `<label class="wf-start-opt"><input type="radio" name="tpl" value="${esc(t.key)}"${i === 0 ? ' checked' : ''}>
      <span><b>${esc(t.label)}</b><small>${esc(t.text)}</small></span></label>`).join('');
    $('stageAt').innerHTML = ['<option value="0">At the start of the run</option>',
      ...wf.stages.map((t, i) => `<option value="${i + 1}">After ${esc(t.role)}</option>`)].join('');
    $('stageAt').value = String(sel + 1);
    $('stageDialog').showModal();
  }
  $('stAdd').addEventListener('click', openStageDialog);
  $('stageCancel').addEventListener('click', () => $('stageDialog').close());
  $('stageForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = document.querySelector('input[name="tpl"]:checked')?.value;
    const template = [...M.STAGE_TEMPLATES, ...savedTemplates()].find((t) => t.key === key);
    $('stageDialog').close();
    if (!template) return;
    const at = Number($('stageAt').value) || 0;
    mutate(() => {
      wf.stages = M.insertStage(wf.stages, at, M.fromTemplate(template, wf.stages, at));
      sel = at;
    });
    msg(`Added ${template.label}. Its settings can be changed in the editor.`, 'ok');
  });
  $('stSaveTpl').addEventListener('click', async () => {
    readForm();
    const s = wf.stages[sel];
    const label = await window.ui.prompt('Name for this stage template', { value: s.role, ok: 'Save' });
    if (label === null) return;
    const list = savedTemplates();
    list.push(M.toTemplate(s, label.trim() || s.role));
    if (!storeTemplates(list)) { window.ui.toast('Could not save the template in this browser', { kind: 'error' }); return; }
    window.ui.toast('Saved as a template. It is in the Add stage list in this browser.');
  });

  // Gateway models for the Model box
  fetch('api/gateway', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((g) => {
    models = [...new Set((g?.deployments || []).map((d) => d.name))];
    $('modelNames').replaceChildren(...models.map((m) => Object.assign(document.createElement('option'), { value: m })));
  }).catch(() => {});

  fillEffort();
  loadList().then(() => {
    if (list.length) return open(list[0].id);
    return null;
  }).catch((err) => msg(`Could not load the workflows: ${err.message}`, 'bad'));
})();
