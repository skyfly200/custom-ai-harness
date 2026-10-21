// Runs page: start a task for an agent, watch it work, answer its questions
// about risky commands, and look at what it changed.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const TAGS = { done: 'ok', running: '', queued: '', waiting: 'warn', incomplete: 'warn', failed: 'bad', stopped: 'warn' };
const NOTE_FOR = { done: 'finished', waiting: 'needs you' };

let selected = location.hash.slice(1) || null;
let runs = [];
let busy = false;
let openDetails = new Set(); // which <details> are open, kept across redraws

async function api(path, options) {
  const res = await fetch(`api/runs${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function renderList() {
  if (!runs.length) { $('list').innerHTML = '<p class="muted">No runs yet.</p>'; return; }
  $('list').innerHTML = runs.map((r) => `<button class="run-item${r.id === selected ? ' on' : ''}" data-id="${esc(r.id)}">
    <span class="goal">${esc(r.goal.split('\n')[0])}</span>
    <span class="meta"><span class="tag ${TAGS[r.status] || ''}">${esc(NOTE_FOR[r.status] || r.status)}</span> ${esc(r.repo.split(/[\\/]/).pop())} · ${ago(r.created)}</span></button>`).join('');
}

function eventHtml(e) {
  const time = `<span class="t">${new Date(e.t).toLocaleTimeString()}</span>`;
  const key = `${e.t}-${e.type}-${e.name || ''}`;
  const open = (k) => (openDetails.has(k) ? ' open' : '');
  if (e.type === 'model') return `<div class="ev model">${time}${e.text ? esc(e.text) : '<span class="muted">(called tools)</span>'} <span class="muted">${esc(e.model || '')}</span></div>`;
  if (e.type === 'tool') {
    const a = e.args || {};
    const brief = a.command ?? a.path ?? (typeof a.summary === 'string' ? a.summary : '') ?? '';
    return `<div class="ev tool">${time}<strong>${esc(e.name)}</strong> <code>${esc(String(brief).slice(0, 200))}</code></div>`;
  }
  if (e.type === 'result') return `<div class="ev"><details data-k="${esc(key)}"${open(key)}><summary>${time}result: ${esc((e.text || '').split('\n')[0].slice(0, 120))}</summary><pre>${esc(e.text)}</pre></details></div>`;
  if (e.type === 'approval_needed') return `<div class="ev approval_needed">${time}Waiting for you: <code>${esc(e.text)}</code> (${esc(e.reason)})</div>`;
  if (e.type === 'approval') return `<div class="ev decided">${time}${e.allowed ? 'Allowed' : 'Declined'}: <code>${esc(e.text)}</code></div>`;
  if (e.type === 'stage') return `<div class="ev stage">${time}<strong>${esc(e.text)}</strong></div>`;
  if (e.type === 'note') return `<div class="ev">${time}${esc(e.text)}</div>`;
  return '';
}

function renderDetail(run) {
  if (!run) { $('detail').innerHTML = '<p class="muted">Pick a run to see what the agent did.</p>'; return; }
  const active = ACTIVE.has(run.status);
  const r = run.result;
  const diffOpen = openDetails.has('diff');
  $('detail').innerHTML = `
    <h3><span class="tag ${TAGS[run.status] || ''}">${esc(run.status)}</span> ${esc(run.goal.split('\n')[0].slice(0, 120))}</h3>
    ${run.goal.includes('\n') || run.goal.length > 120 ? `<div class="goal-full">${esc(run.goal)}</div>` : ''}
    <div class="facts"><span>Repo <code>${esc(run.repo)}</code></span><span>Branch <code>${esc(run.branch)}</code></span>${run.workflowName ? `<span>Workflow ${esc(run.workflowName)}${run.stage ? ` · ${esc(run.stage)}` : ''}</span>` : ''}<span>Steps ${run.steps}</span><span>${(run.tokens.in + run.tokens.out).toLocaleString()} tokens</span>${run.profile ? `<span>Routing ${esc(run.profile)}</span>` : ''}${run.effort ? `<span>Effort ${esc(run.effort)}</span>` : ''}</div>
    ${run.pending ? `<div class="approval"><strong>The agent wants to ${run.pending.kind === 'write' ? 'write this file' : 'run this command'}</strong> <span class="muted">(${esc(run.pending.reason)})</span><pre>${esc(run.pending.text)}</pre><div class="actions"><button class="primary" data-act="allow">Allow</button><button data-act="decline">Decline</button></div></div>` : ''}
    ${run.error ? `<div class="result"><span class="tag bad">error</span> ${esc(run.error)}</div>` : ''}
    ${r ? `<div class="result"><p class="summary">${esc(r.summary)}</p>
      ${r.diffStat ? `<pre>${esc(r.diffStat)}</pre>` : '<p class="muted">No files changed.</p>'}
      ${r.tests ? `<p>${r.tests.passed ? '<span class="tag ok">tests pass</span>' : `<span class="tag bad">tests fail${r.tests.timedOut ? ' (timed out)' : ''}</span>`} <code>${esc(r.tests.command)}</code></p><details data-k="tests"${openDetails.has('tests') ? ' open' : ''}><summary>Test output</summary><pre>${esc(r.tests.output)}</pre></details>` : ''}
      ${r.commit ? `<p class="muted">Review it in your repo: <code>git diff ${esc(run.base.slice(0, 10))}..${esc(run.branch)}</code>, then push the branch when you are happy.</p><details data-k="diff"${diffOpen ? ' open' : ''}><summary>Show the changes</summary><pre id="diffText">Loading…</pre></details>` : ''}</div>` : ''}
    <div class="actions">${active ? '<button data-act="stop">Stop</button>' : '<button data-act="remove" data-hint="Removes the workspace and this record. The branch stays in your repo">Delete run</button>'}</div>
    <div class="timeline">${run.events.map(eventHtml).join('')}</div>`;
  if (r?.commit && diffOpen) loadDiff(run.id);
}

async function loadDiff(id) {
  try {
    const res = await fetch(`api/runs/${id}/diff`);
    const el = $('diffText');
    if (el) el.textContent = (await res.text()) || '(no changes)';
  } catch { /* leave it */ }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const list = await api('');
    $('down').hidden = true;
    runs = list.runs;
    renderList();
    if (selected) {
      const run = await api(`/${selected}`).catch(() => null);
      renderDetail(run);
    }
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $('down').hidden = false;
    $('down').textContent = err.message;
    $('updated').textContent = 'Task runner unreachable';
  } finally {
    busy = false;
  }
}

$('list').addEventListener('click', (e) => {
  const b = e.target.closest('.run-item');
  if (!b) return;
  selected = b.dataset.id;
  location.hash = selected;
  openDetails = new Set();
  renderList();
  refresh();
});

$('detail').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !selected) return;
  try {
    if (act === 'allow') await post(`/${selected}/approve`, { allow: true });
    if (act === 'decline') await post(`/${selected}/approve`, { allow: false });
    if (act === 'stop') await post(`/${selected}/stop`);
    if (act === 'remove') {
      if (!confirm('Delete this run? Its branch stays in your repo.')) return;
      await api(`/${selected}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
      selected = null; location.hash = '';
      renderDetail(null);
    }
  } catch (err) { alert(err.message); }
  refresh();
});

// Remember which result boxes are open so the 1.5 s redraw doesn't close them
$('detail').addEventListener('toggle', (e) => {
  const k = e.target.dataset?.k;
  if (!k) return;
  if (e.target.open) openDetails.add(k); else openDetails.delete(k);
  if (k === 'diff' && e.target.open && selected) loadDiff(selected);
}, true);

$('newRun').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(new FormData(f));
  for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
  try {
    $('startMsg').textContent = 'Starting…';
    if (body.workflow === 'auto') {
      const pick = lastPick?.goal === body.goal ? lastPick : await pickWorkflow(body.goal);
      body.workflow = pick?.id || 'general';
    }
    const run = await post('', body);
    selected = run.id; location.hash = run.id; openDetails = new Set();
    f.elements.goal.value = '';
    $('startMsg').textContent = '';
    refresh();
  } catch (err) { $('startMsg').textContent = err.message; }
});

// Workflows: the picker asks Jev about the goal a moment after you stop typing
let lastPick = null;
let workflowList = [];
let pickTimer = null;
const nameOf = (id) => workflowList.find((w) => w.id === id)?.name || id;

async function pickWorkflow(goal) {
  const r = await (await fetch('api/workflows/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) })).json();
  lastPick = { ...r, goal };
  if (r.id) $('pickNote').textContent = r.by === 'jev'
    ? `Jev picks “${nameOf(r.id)}” (${Math.round(r.p * 100)}% sure). Choose another workflow to override.`
    : `“${nameOf(r.id)}” (Jev wasn't sure enough to choose a specific recipe).`;
  return lastPick;
}

function schedulePick() {
  clearTimeout(pickTimer);
  const goal = $('newRun').elements.goal.value.trim();
  if ($('workflow').value !== 'auto' || goal.length < 8) { $('pickNote').textContent = ''; return; }
  pickTimer = setTimeout(() => pickWorkflow(goal).catch(() => {}), 700);
}

async function initWorkflows() {
  try {
    const { workflows } = await (await fetch('api/workflows')).json();
    workflowList = workflows;
    $('workflow').insertAdjacentHTML('beforeend', workflows.map((w) => `<option value="${esc(w.id)}" title="${esc(`Fits: ${w.when}. Stages: ${w.stages.map((s) => s.role).join(' → ')}`)}">${esc(w.name)} (${w.stages.length} ${w.stages.length === 1 ? 'stage' : 'stages'})</option>`).join(''));
  } catch { /* auto still works without the list */ }
  $('newRun').elements.goal.addEventListener('input', schedulePick);
  $('workflow').addEventListener('change', () => { $('pickNote').textContent = ''; if ($('workflow').value === 'auto') schedulePick(); });
}

async function init() {
  initWorkflows();
  try {
    const { repos, roots } = await api('/repos');
    $('repos').innerHTML = repos.map((r) => `<option value="${esc(r)}">`).join('');
    if (!repos.length) $('newRun').elements.repo.placeholder = `Paste a path inside ${roots.join(' or ') || 'RUNNER_ROOTS'}`;
    if (repos.length === 1) $('newRun').elements.repo.value = repos[0];
  } catch { /* the notice shows it */ }
  try {
    const { profiles } = await (await fetch('api/profiles')).json();
    $('newRun').elements.profile.insertAdjacentHTML('beforeend', profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') + '<option value="auto">Jev picks (auto)</option>');
  } catch { /* the default routing is enough */ }
  refresh();
  setInterval(refresh, 1500);
}
init();
