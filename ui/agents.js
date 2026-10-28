// Agents page: named, long-lived agents and their tasks, plus one-off runs. Start
// a task, watch it work, answer its questions about risky commands, and look at
// what it changed.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['queued', 'running', 'waiting']);
// Retry is for a run that went wrong; Continue is for one that only ran out of steps or time
const RETRYABLE = new Set(['done', 'failed', 'stopped']);
const CONTINUABLE = new Set(['incomplete']);
const DEBUGGABLE = new Set(['failed', 'stopped']);
const TAGS = { done: 'ok', running: '', queued: '', waiting: 'warn', incomplete: 'warn', failed: 'bad', stopped: 'warn' };
const NOTE_FOR = { done: 'finished', waiting: 'needs you' };
// a run stopped at its cost limit is "incomplete" to the runner; say why
const statusWord = (r) => (r.status === 'incomplete' && r.outOfBudget ? 'cost limit' : NOTE_FOR[r.status] || r.status);

let selected = location.hash.slice(1) || null;
let runs = [];
let agents = [];
let agentSel = null;   // the agent whose tasks are shown, or null for every run
let busy = false;
let openDetails = new Set(); // which <details> are open, kept across redraws

async function api(path, options) {
  const res = await fetch(`api/runs${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const agentApi = async (path, options) => {
  const res = await fetch(`api/agents${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};
const sendAgent = (method, path, body) => agentApi(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const agentOf = (id) => agents.find((a) => a.id === id);
// chat projects live in the browser; the agent keeps a project's id and name
function chatProjects() {
  try { const p = JSON.parse(localStorage.getItem('harness-projects')); return Array.isArray(p) ? p : []; } catch { return []; }
}
const projectName = (link) => chatProjects().find((p) => p.id === link.id)?.name || link.name || 'a project';
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// a swarm's cost includes its workers'
const runCost = (r) => {
  const all = [r, ...runs.filter((x) => x.parent === r.id)];
  const cost = all.reduce((n, x) => n + (x.cost || 0), 0), unpriced = all.reduce((n, x) => n + (x.unpricedCalls || 0), 0);
  return (cost || !unpriced ? Costs.usd(cost) : '$?') + (unpriced ? '+' : '');
};
const agentSpend = (id) => {
  const own = runs.filter((r) => r.agent === id);
  const ids = new Set(own.map((r) => r.id));
  const all = runs.filter((r) => ids.has(r.id) || ids.has(r.parent));
  const cost = all.reduce((n, r) => n + (r.cost || 0), 0), unpriced = all.reduce((n, r) => n + (r.unpricedCalls || 0), 0);
  return (cost || !unpriced ? Costs.usd(cost) : '$?') + (unpriced ? '+' : '');
};
const shown = () => (agentSel ? runs.filter((r) => r.agent === agentSel) : runs);

function renderList() {
  const list = shown();
  $('listTitle').textContent = agentSel ? `${agentOf(agentSel)?.name || 'Agent'}: tasks` : 'Runs';
  if (!list.length) { $('list').innerHTML = `<p class="muted">${agentSel ? 'No tasks yet. Give it one above.' : 'No runs yet.'}</p>`; return; }
  $('list').innerHTML = list.map((r) => `<button class="run-item${r.id === selected ? ' on' : ''}" data-id="${esc(r.id)}">
    <span class="goal">${esc(r.goal.split('\n')[0])}</span>
    <span class="meta">${!agentSel && agentOf(r.agent) ? `<span class="agent-tag">${esc(agentOf(r.agent).name)}</span> · ` : ''}${r.kind === 'swarm' ? '<span class="tag">swarm</span> ' : r.kind === 'chatdev' ? '<span class="tag">chatdev</span> ' : ''}${r.parent ? '↳ ' : ''}<span class="tag ${TAGS[r.status] || ''}">${esc(statusWord(r))}</span> ${esc(r.repo.split(/[\\/]/).pop())} · ${ago(r.created)}</span></button>`).join('');
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
  if (e.type === 'plan') return `<div class="ev stage">${time}<strong>Plan</strong><pre>${esc(e.text)}</pre></div>`;
  if (e.type === 'stage') return `<div class="ev stage">${time}<strong>${esc(e.text)}</strong></div>`;
  if (e.type === 'note') return `<div class="ev">${time}${esc(e.text)}</div>`;
  return '';
}

function renderDetail(run) {
  if (!run) { $('detail').innerHTML = `<p class="muted">Pick a ${agentSel ? 'task' : 'run'} to see what the agent did.</p>`; return; }
  const active = ACTIVE.has(run.status);
  const r = run.result;
  const diffOpen = openDetails.has('diff');
  $('detail').innerHTML = `
    <h3><span class="tag ${TAGS[run.status] || ''}">${esc(run.status === 'incomplete' && run.outOfBudget ? 'cost limit' : run.status)}</span> ${esc(run.goal.split('\n')[0].slice(0, 120))}</h3>
    ${run.goal.includes('\n') || run.goal.length > 120 ? `<div class="goal-full">${esc(run.goal)}</div>` : ''}
    <div class="facts">${run.plan ? '<span class="tag plan" title="Plan only: nothing was changed or committed">Plan only</span>' : ''}<span>Repo <code>${esc(run.repo)}</code></span>${run.plan ? '' : `<span>Branch <code>${esc(run.branch)}</code></span>`}${run.workflowName ? `<span>Workflow ${esc(run.workflowName)}${run.stage ? ` · ${esc(run.stage)}` : ''}</span>` : ''}<span>Steps ${run.steps}</span><span>${(run.tokens.in + run.tokens.out).toLocaleString()} tokens</span><span title="${run.unpricedCalls ? `${run.unpricedCalls} model call(s) had no known price, so the real cost is higher` : 'Priced like the Usage page'}">Cost ${runCost(run)}${run.maxCost ? ` of ${Costs.usd(run.maxCost)} limit` : ''}</span>${run.profile ? `<span>Routing ${esc(run.profile)}</span>` : ''}${run.effort ? `<span>Effort ${esc(run.effort)}</span>` : ''}${run.maxTier ? `<span>Highest tier ${esc(run.maxTier)}</span>` : ''}${run.bumps ? `<span title="A failure made this run ask for a stronger model">Escalated ${run.bumps}×</span>` : ''}${run.sandbox && run.sandbox !== 'local' ? `<span>Sandbox ${esc(SANDBOX_NAMES[run.sandbox] || run.sandbox)}${run.sandboxId ? ` <code>${esc(run.sandboxId)}</code>` : ''}</span>` : ''}</div>
    ${run.agent && agentOf(run.agent) ? `<p class="muted">A task of <a href="#${esc(run.agent)}" data-agent="${esc(run.agent)}">${esc(agentOf(run.agent).name)}</a>${run.source?.chat ? `, handed over from the chat <a href="chat.html#chat=${encodeURIComponent(run.source.chat.id)}">${esc(run.source.chat.title || 'a chat')}</a>` : ''}.</p>` : run.source?.chat ? `<p class="muted">Handed over from the chat <a href="chat.html#chat=${encodeURIComponent(run.source.chat.id)}">${esc(run.source.chat.title || 'a chat')}</a>.</p>` : ''}
    ${run.parent ? `<p class="muted">A worker in <a href="#${esc(run.parent)}" data-go="${esc(run.parent)}">its swarm</a>.</p>` : ''}
    ${run.debugOf ? `<p class="muted">Debugging <a href="#${esc(run.debugOf)}" data-go="${esc(run.debugOf)}">the run that failed</a>. It was told what went wrong there.</p>` : ''}
    ${run.legs ? `<p class="muted">Carried on ${run.legs === 1 ? 'once' : `${run.legs} times`} after running out of ${run.outOfBudget ? 'budget' : run.outOfSteps ? 'steps' : 'time'}; every part worked on this one branch.</p>` : ''}
    ${run.debugRun && runs.some((x) => x.id === run.debugRun) ? `<p class="muted">Auto debug (or a retry) started <a href="#${esc(run.debugRun)}" data-go="${esc(run.debugRun)}">${esc(run.debugRun)}</a>.</p>` : ''}
    ${run.children?.length ? `<div class="result"><strong>Workers</strong><div class="workers">${run.children.map((id, i) => {
      const c = runs.find((x) => x.id === id);
      if (!id) return `<span class="worker muted">${esc(run.parts?.[i]?.title || `Part ${i + 1}`)} · waiting for what it depends on</span>`;
      return `<button class="worker" data-go="${esc(id)}"><span class="tag ${TAGS[c?.status] || ''}">${esc(NOTE_FOR[c?.status] || c?.status || '?')}</span> ${esc(run.parts?.[i]?.title || `Part ${i + 1}`)} <span class="muted">step ${c?.steps ?? 0}</span></button>`;
    }).join('')}</div></div>` : ''}
    ${run.pending ? `<div class="approval"><strong>The agent wants to ${run.pending.kind === 'write' ? 'write this file' : 'run this command'}</strong> <span class="muted">(${esc(run.pending.reason)})</span><pre>${esc(run.pending.text)}</pre><div class="actions"><button class="primary" data-act="allow">Allow</button><button data-act="decline">Decline</button></div></div>` : ''}
    ${run.error ? `<div class="result"><span class="tag bad">error</span> ${esc(run.error)}</div>` : ''}
    ${r ? `<div class="result">${run.plan ? '<p class="muted">Plan only: nothing was changed, so there is no branch to review.</p>' : ''}<p class="summary">${esc(r.summary)}</p>
      ${run.plan ? '' : r.diffStat ? `<pre>${esc(r.diffStat)}</pre>` : '<p class="muted">No files changed.</p>'}
      ${r.tests ? `<p>${r.tests.passed ? '<span class="tag ok">tests pass</span>' : `<span class="tag bad">tests fail${r.tests.timedOut ? ' (timed out)' : ''}</span>`} <code>${esc(r.tests.command)}</code></p><details data-k="tests"${openDetails.has('tests') ? ' open' : ''}><summary>Test output</summary><pre>${esc(r.tests.output)}</pre></details>` : ''}
      ${r.commit ? `<p class="muted">Review it in your repo: <code>git diff ${esc(run.base.slice(0, 10))}..${esc(run.branch)}</code>, then push the branch when you are happy.</p><details data-k="diff"${diffOpen ? ' open' : ''}><summary>Show the changes</summary><pre id="diffText">Loading…</pre></details>` : ''}</div>` : ''}
    <div class="actions">${active
      ? `${run.legs || run.carriesOn ? '<span class="muted">Carrying on…</span> ' : ''}<button data-act="stop">Stop</button>`
      : `<button data-act="remove" data-hint="Removes the workspace and this record. The branch stays in your repo">Delete run</button>${CONTINUABLE.has(run.status) && !run.parent && run.kind !== 'swarm' && run.kind !== 'chatdev' ? '<button data-act="continue" data-hint="Carries this run on in the same branch, from what the earlier part committed, with a full set of steps and minutes again">Continue</button>' : ''}${RETRYABLE.has(run.status) && !run.parent && run.kind !== 'swarm' ? '<button data-act="retry" data-hint="Starts the same task again from the same commit, on a fresh branch">Retry run</button>' : ''}${DEBUGGABLE.has(run.status) && !run.parent ? '<button data-act="debug" data-hint="Starts it again and tells the agent what went wrong this time: the error, the failed tests, the last things it did">Auto debug</button>' : ''}`}</div>
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

// the terminal lives outside the detail pane, which is redrawn on every refresh
let runTerminal = null;
function drawTerminal(run) {
  const panel = $('termPanel');
  const has = run && run.events.some((e) => e.type === 'tool' && e.name === 'run_command');
  panel.hidden = !has;
  if (!has) return;
  runTerminal ||= window.RunTerminal?.mount($('termHost'));
  runTerminal?.update(run);
}
$('termPanel').addEventListener('toggle', () => { if ($('termPanel').open) setTimeout(() => runTerminal?.refit(), 0); });

// Preview: the run's dev server. Drawn outside the detail pane so the form keeps what you typed.
let previewFor = null;
const PREVIEW_KEY = 'harness-preview-command';
async function drawPreview(run) {
  const panel = $('previewPanel');
  const ok = run && run.kind === 'run' && !run.plan && (!run.sandbox || run.sandbox === 'local') && run.status !== 'queued';
  panel.hidden = !ok;
  if (!ok) { previewFor = null; return; }
  if (previewFor !== run.id) {
    previewFor = run.id;
    try { $('previewCmd').value = localStorage.getItem(PREVIEW_KEY) || ''; } catch { $('previewCmd').value = ''; }
    $('previewMsg').textContent = '';
  }
  const st = await api(`/${run.id}/preview`).catch(() => ({ running: false }));
  $('previewStop').hidden = !st.running;
  $('previewStart').disabled = Boolean(st.running);
  $('previewInfo').innerHTML = st.url ? `<p>${st.running ? (st.ready ? '<span class="tag ok">running</span>' : '<span class="tag">starting</span>') : `<span class="tag bad">exited (${esc(st.exited)})</span>`} <a href="${esc(st.url)}" target="_blank" rel="noopener">${esc(st.url)}</a> <code>${esc(st.command)}</code></p><pre>${esc((st.log || []).join('\n'))}</pre>` : '';
}
// Ship and undo: only for a change to a registered app. Shows what the checks found, and the
// buttons stay off while something blocks it.
let shipFor = null;
async function drawShip(run) {
  const panel = $('shipPanel');
  const ok = run && run.app && ['done', 'incomplete'].includes(run.status);
  panel.hidden = !ok;
  if (!ok) { shipFor = null; return; }
  if (shipFor !== run.id) { shipFor = run.id; $('shipMsg').textContent = ''; }
  let v;
  try { v = await api(`/${run.id}/ship`); } catch (err) { $('shipInfo').textContent = err.message; return; }
  const lines = [];
  lines.push(`<p>${v.files.length} file${v.files.length === 1 ? '' : 's'}, ${v.lines} lines changed · tests ${v.tests === null ? 'not run' : v.tests ? '<span class="tag ok">pass</span>' : '<span class="tag bad">fail</span>'}</p>`);
  for (const b of v.blocked) lines.push(`<p class="tag bad">${esc(b)}</p>`);
  for (const n of v.notes) lines.push(`<p class="muted">${esc(n)}</p>`);
  if (v.shipped) lines.push(`<p><span class="tag ok">shipped</span> <a href="${esc(v.shipped.url)}" target="_blank" rel="noopener">pull request ${esc(v.shipped.pr)}</a> merged into ${esc(v.shipped.base)}</p>`);
  if (v.undone) lines.push(`<p><span class="tag">undone</span> <a href="${esc(v.undone.url)}" target="_blank" rel="noopener">revert pull request ${esc(v.undone.pr)}</a></p>`);
  $('shipInfo').innerHTML = lines.join('');
  $('shipBtn').disabled = !v.canShip || Boolean(v.shipped);
  $('undoBtn').hidden = !v.shipped || Boolean(v.undone);
}
async function shipAction(path, ask) {
  if (!selected || !confirm(ask)) return;
  $('shipMsg').textContent = 'Working…';
  try {
    const res = await fetch(`api/runs/${selected}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    $('shipMsg').textContent = 'Done.';
    shipFor = null;
    await drawShip(await api(`/${selected}`));
  } catch (err) { $('shipMsg').textContent = err.message; }
}
$('shipBtn').addEventListener('click', () => shipAction('ship', 'Merge this change into the app on GitHub? Its normal pipeline then deploys it.'));
$('undoBtn').addEventListener('click', () => shipAction('undo', 'Open and merge a revert pull request for this change?'));

$('previewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const command = $('previewCmd').value.trim();
  if (!selected) return;
  try { if (command) localStorage.setItem(PREVIEW_KEY, command); } catch { /* fine */ }
  const start = (approved) => fetch(`api/runs/${selected}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, approved }) });
  try {
    $('previewMsg').textContent = 'Starting…';
    let res = await start(false);
    let body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.needsApproval) {
      if (!confirm(`${body.error}\n\nRun this command in the workspace?\n${command}`)) { $('previewMsg').textContent = ''; return; }
      res = await start(true);
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    $('previewMsg').textContent = body.ready ? '' : 'It has not answered yet; see the log below.';
    previewFor = null;
    await drawPreview(await api(`/${selected}`));
  } catch (err) { $('previewMsg').textContent = err.message; }
});
$('previewStop').addEventListener('click', async () => {
  try {
    await fetch(`api/runs/${selected}/preview`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
    previewFor = null;
    await drawPreview(await api(`/${selected}`));
  } catch (err) { $('previewMsg').textContent = err.message; }
});

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const [list, ag] = await Promise.all([api(''), agentApi('')]);
    $('down').hidden = true;
    runs = list.runs;
    window.Notify?.watchRuns(runs);
    agents = ag.agents;
    if (agentSel && !agentOf(agentSel)) agentSel = null;
    renderAgents();
    renderList();
    if (selected) {
      const run = await api(`/${selected}`).catch(() => null);
      renderDetail(run);
      drawTerminal(run);
      drawPreview(run);
      drawShip(run);
    } else { drawTerminal(null); drawPreview(null); drawShip(null); }
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
  const goAgent = e.target.closest('[data-agent]')?.dataset.agent;
  if (goAgent) { e.preventDefault(); chooseAgent(goAgent); return; }
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (go) { e.preventDefault(); selected = go; location.hash = go; openDetails = new Set(); renderList(); refresh(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !selected) return;
  try {
    if (act === 'allow') await post(`/${selected}/approve`, { allow: true });
    if (act === 'decline') await post(`/${selected}/approve`, { allow: false });
    if (act === 'stop') await post(`/${selected}/stop`);
    if (act === 'retry' || act === 'debug') {
      const made = await post(`/${selected}/retry`, { debug: act === 'debug' });
      selected = made.id; location.hash = made.id; openDetails = new Set();
    }
    // a continue is the same run, so the page stays on it
    if (act === 'continue') await post(`/${selected}/continue`);
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

// Save the ticket draft as markdown files in the repo (preview, ask, write), or load a folder back
async function ticketCall(path, body) {
  const res = await fetch(`api/tickets/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}
$('fileTickets').addEventListener('click', async () => {
  const f = $('newRun'), msg = $('ticketsMsg');
  const body = { tickets: f.elements.tickets.value, repo: f.elements.repo.value.trim() };
  try {
    msg.textContent = 'Checking…';
    const plan = await ticketCall('files', { ...body, confirm: false });
    if (!confirm(`Write ${plan.files.length} files into ${plan.repo}/${plan.folder}?\n\n${plan.files.map((x) => `· ${x.name}`).join('\n')}`)) { msg.textContent = ''; return; }
    const made = await ticketCall('files', { ...body, confirm: true });
    msg.textContent = `Wrote ${made.files.length} files to ${made.relative}. Commit them when you are happy.`;
  } catch (err) { msg.textContent = err.message; }
});
$('loadTickets').addEventListener('click', async () => {
  const f = $('newRun'), msg = $('ticketsMsg');
  const folder = prompt('Folder inside the repo, for example wayfinder/add-export');
  if (!folder) return;
  try {
    const draft = await ticketCall('read', { repo: f.elements.repo.value.trim(), folder });
    f.elements.tickets.value = JSON.stringify({ tickets: draft.tickets }, null, 2);
    msg.textContent = `Loaded ${draft.tickets.length} tickets${draft.skipped.length ? `; skipped ${draft.skipped.join(', ')}` : ''}.`;
  } catch (err) { msg.textContent = err.message; }
});

$('newRun').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(new FormData(f));
  for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
  // an unchecked box is absent from FormData, and the runner's default may be on
  body.autoDebug = f.elements.autoDebug?.checked ? '1' : '0';
  body.plan = f.elements.plan?.checked ? '1' : '0';
  body.auditParts = f.elements.auditParts?.checked ? '1' : '0';
  body.escalate = f.elements.escalate?.checked ? '1' : '0';
  try {
    $('startMsg').textContent = 'Starting…';
    if (body.workflow === 'auto') {
      const pick = lastPick?.goal === body.goal ? lastPick : await pickWorkflow(body.goal);
      body.workflow = pick?.id || 'general';
    }
    let run;
    if (agentSel) {
      const task = { goal: body.goal, plan: body.plan === '1', ...(body.maxSteps !== undefined ? { maxSteps: body.maxSteps } : {}), ...(body.maxMinutes !== undefined ? { maxMinutes: body.maxMinutes } : {}), ...(body.maxCost !== undefined ? { maxCost: body.maxCost } : {}) };
      run = await sendAgent('POST', `/${agentSel}/tasks`, task);
    } else run = await post('', body);
    if (!agentSel && body.repo) { rememberRepo(body.repo); renderRecent(); }
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
  if (agentSel || $('workflow').value !== 'auto' || goal.length < 8) { $('pickNote').textContent = ''; return; }
  pickTimer = setTimeout(() => pickWorkflow(goal).catch(() => {}), 700);
}

async function initWorkflows() {
  try {
    const { workflows } = await (await fetch('api/workflows')).json();
    workflowList = workflows;
    $('workflow').insertAdjacentHTML('beforeend', workflows.map((w) => `<option value="${esc(w.id)}" title="${esc(`Fits: ${w.when}. Stages: ${w.stages.map((s) => s.role).join(' → ')}`)}">${esc(w.name)} (${w.stages.length} ${w.stages.length === 1 ? 'stage' : 'stages'})</option>`).join(''));
    $('workflow').insertAdjacentHTML('beforeend', '<option value="swarm" title="A planner splits the goal, workers do the parts at the same time on their own branches, the branches are merged, and a reviewer checks the result">Swarm (several agents at once)</option><option value="chatdev" title="Runs ChatDev (an external multi-agent tool) in a cloud sandbox with its models routed through this harness; needs CHATDEV_HARNESS_URL">ChatDev (in a cloud sandbox)</option>');
  } catch { /* auto still works without the list */ }
  $('newRun').elements.goal.addEventListener('input', schedulePick);
  $('workflow').addEventListener('change', () => { applyMode(); $('pickNote').textContent = ''; if ($('workflow').value === 'auto') schedulePick(); });
}

// Repo picker: type or paste a path, pick a recent one, or browse the allowed folders
const RECENT_KEY = 'harness-runs-recent-repos';
let pickData = null;   // the folder listing shown in the dialog
let pickRepo = '';     // the repo chosen in the dialog
let pickInto = null;   // the input the chosen repo goes into

function recentRepos() {
  try { const r = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function rememberRepo(repo) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([repo, ...recentRepos().filter((r) => r !== repo)].slice(0, 6))); } catch { /* private window */ }
}
function renderRecent(extra = []) {
  const list = [...new Set([...recentRepos(), ...extra])].slice(0, 6);
  $('recent').innerHTML = list.map((r) => `<button type="button" class="chip" data-repo="${esc(r)}" title="${esc(r)}">${esc(r.split(/[\\/]/).filter(Boolean).pop() || r)}</button>`).join('');
}

function renderPicker() {
  const d = pickData;
  const q = $('pickFilter').value.trim().toLowerCase();
  const rows = d.entries.filter((e) => !q || e.name.toLowerCase().includes(q));
  $('crumbs').innerHTML = `<button type="button" class="crumb" data-dir="">Allowed folders</button>${d.path ? ` <span class="muted">›</span> <code>${esc(d.path)}</code>` : ''}`;
  const up = d.path && d.parent !== null ? `<div class="pick-row up" data-dir="${esc(d.parent)}" role="option" tabindex="0"><span class="ico">↰</span> Up one folder</div>` : '';
  $('pickList').innerHTML = up + (rows.map((e) => `<div class="pick-row${e.path === pickRepo ? ' on' : ''}" data-dir="${esc(e.path)}" data-git="${e.git ? 1 : 0}" role="option" tabindex="0"><span class="ico">${e.git ? '◆' : '▸'}</span><span class="nm">${esc(e.name)}</span>${e.git ? '<span class="tag ok">git repo</span>' : ''}</div>`).join('')
    || `<p class="muted pad">${d.entries.length ? 'No folder matches.' : 'No folders here.'}</p>`);
  $('pickUse').disabled = !pickRepo;
  $('pickHint').textContent = pickRepo || 'Click a ◆ git repo to choose it; click any other folder to open it.';
}

async function pickerGo(dir, showParent = false) {
  try {
    pickData = await api(`/browse?path=${encodeURIComponent(dir || '')}`);
    // opening on a repo that is already typed: show the folder it is in, with it ticked
    if (showParent && pickData.git && pickData.parent !== null) {
      const chosen = pickData.path;
      pickData = await api(`/browse?path=${encodeURIComponent(pickData.parent)}`);
      pickRepo = chosen;
      $('pickFilter').value = '';
      return renderPicker();
    }
  } catch (err) {
    if (!dir) { $('pickHint').textContent = err.message; return; }
    return pickerGo('');   // the typed path was not browsable: start from the allowed folders
  }
  pickRepo = pickData.git ? pickData.path : '';
  $('pickFilter').value = '';
  renderPicker();
}

async function initRepoPicker() {
  let repos = [];
  try {
    const r = await api('/repos');
    repos = r.repos;
    if (!repos.length) $('repo').placeholder = `Paste a path inside ${r.roots.join(' or ') || 'RUNNER_ROOTS'}`;
    if (repos.length === 1) $('repo').value = repos[0];
  } catch { /* the notice shows it */ }
  const last = recentRepos()[0];
  if (!$('repo').value && last) $('repo').value = last;
  renderRecent(repos);
  $('recent').addEventListener('click', (e) => { const b = e.target.closest('[data-repo]'); if (b) $('repo').value = b.dataset.repo; });
  const browseFor = (input) => { pickInto = input; $('picker').showModal(); pickerGo(input.value.trim(), true); };
  $('browse').addEventListener('click', () => browseFor($('repo')));
  $('agentBrowse').addEventListener('click', () => browseFor($('agentRepo')));
  $('pickClose').addEventListener('click', () => $('picker').close());
  $('pickFilter').addEventListener('input', () => pickData && renderPicker());
  $('crumbs').addEventListener('click', (e) => { if (e.target.closest('[data-dir]')) pickerGo(''); });
  $('pickList').addEventListener('click', (e) => {
    const row = e.target.closest('.pick-row');
    if (!row) return;
    if (row.dataset.git === '1') { pickRepo = row.dataset.dir; renderPicker(); } else pickerGo(row.dataset.dir);
  });
  $('pickList').addEventListener('dblclick', (e) => { const row = e.target.closest('.pick-row'); if (row && row.dataset.git === '1') pickerGo(row.dataset.dir); });
  $('pickList').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('.pick-row')?.click(); });
  $('pickUse').addEventListener('click', () => { (pickInto || $('repo')).value = pickRepo; $('picker').close(); });
}

// the sandbox drivers (this machine, E2B, Sprites): fill both Sandbox pickers, marking the ones whose key is missing
const SANDBOX_NAMES = { local: 'This machine', e2b: 'E2B', sprites: 'Fly Sprite' };
async function initSandboxes() {
  try {
    const { default: def, drivers } = await api('/sandboxes');
    const options = drivers.map((d) => `<option value="${esc(d.id)}"${d.configured ? '' : ' disabled'}>${esc(d.name)}${d.configured ? '' : ` (needs ${esc(d.needs)})`}</option>`).join('');
    for (const sel of document.querySelectorAll('.sandbox-select')) sel.innerHTML = `<option value="">Default (${esc(SANDBOX_NAMES[def] || def)})</option>${options}`;
  } catch { /* the runner's default is enough */ }
}

async function init() {
  initSandboxes();
  initWorkflows();
  await initRepoPicker();
  try {
    const { profiles } = await (await fetch('api/profiles')).json();
    $('newRun').elements.profile.insertAdjacentHTML('beforeend', profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') + '<option value="auto">Jev picks (auto)</option>');
  } catch { /* the default routing is enough */ }
  await initAgentDialog();
  const first = location.hash.slice(1);
  if (first.startsWith('a')) { selected = null; agentSel = first; }
  await refresh();
  // a run's link opens on the agent it belongs to
  if (selected && !agentSel) agentSel = runs.find((r) => r.id === selected)?.agent || null;
  applyMode();
  renderAgents(); renderList();
  setInterval(refresh, 1500);
}
init();

// ---------------------------------------------------------------------------
// Agents: a bar to pick one, its details, and the dialog to make or edit one
// ---------------------------------------------------------------------------
function renderAgents() {
  const chip = (a) => `<button type="button" class="agent-chip${agentSel === a.id ? ' on' : ''}" data-aid="${esc(a.id)}" title="${esc(a.repo)}">${a.active ? `<i class="dot${a.waiting ? ' warn' : ''}" title="${a.waiting ? 'Needs you' : 'Working'}"></i>` : ''}${esc(a.name)}</button>`;
  $('agentChips').innerHTML = `<button type="button" class="agent-chip${agentSel ? '' : ' on'}" data-aid="">All runs</button>${agents.map(chip).join('')}<button type="button" class="chip" id="newAgent" data-hint="Make a named agent for a repo that keeps working on it task after task">+ New agent</button>`;
  const a = agentOf(agentSel);
  $('agentInfo').hidden = !a;
  if (a) {
    $('agentInfo').innerHTML = `<div class="facts"><span>Repo <code>${esc(a.repo)}</code></span><span>Workflow ${esc(nameOf(a.workflow))}</span>${a.profile ? `<span>Routing ${esc(a.profile)}</span>` : ''}${a.effort ? `<span>Effort ${esc(a.effort)}</span>` : ''}${a.sandbox ? `<span>Sandbox ${esc(SANDBOX_NAMES[a.sandbox] || a.sandbox)}</span>` : ''}<span>${a.taskCount} task${a.taskCount === 1 ? '' : 's'}</span><span title="What this agent's tasks cost, swarm workers included">Spent ${agentSpend(a.id)}</span>${a.project ? `<span>Chat project <a href="chat.html#project=${encodeURIComponent(a.project.id)}">${esc(projectName(a.project))}</a></span>` : ''}${a.branch ? `<span>Work so far on <code>${esc(a.branch)}</code></span>` : '<span>No work committed yet</span>'}</div>
      ${a.instructions ? `<div class="instr">${esc(a.instructions)}</div>` : ''}
      <div class="actions"><button type="button" data-aact="edit">Edit</button><button type="button" data-aact="delete" data-hint="Removes the agent. Its tasks stay in the list as ordinary runs and their branches stay in your repo">Delete agent</button></div>`;
  }
}

// the form is for one-off runs, or for a task of the selected agent
function applyMode() {
  const f = $('newRun');
  const a = agentOf(agentSel);
  for (const el of f.querySelectorAll('.oneoff')) {
    el.hidden = Boolean(a) || (['ticketsField', 'auditField'].includes(el.id) && $('workflow').value !== 'swarm');
    for (const input of el.querySelectorAll('input, select, textarea')) input.disabled = Boolean(a);
  }
  $('formTitle').textContent = a ? `Give ${a.name} a task` : 'Start a run';
  $('startBtn').textContent = a ? 'Give task' : 'Start run';
  f.elements.goal.placeholder = a ? 'What should it do next? It starts from what its last task committed.' : 'Fix the failing test in utils/tiers.test.js, or: add a --version flag to the CLI';
  if (a) $('pickNote').textContent = '';
}

function chooseAgent(id) {
  agentSel = id || null;
  selected = null;
  location.hash = agentSel || '';
  openDetails = new Set();
  applyMode(); renderAgents(); renderList(); renderDetail(null); drawTerminal(null);
}
$('agentChips').addEventListener('click', (e) => {
  if (e.target.closest('#newAgent')) return openAgentDialog(null);
  const b = e.target.closest('[data-aid]');
  if (b) chooseAgent(b.dataset.aid);
});
$('agentInfo').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-aact]')?.dataset.aact;
  const a = agentOf(agentSel);
  if (!act || !a) return;
  if (act === 'edit') return openAgentDialog(a);
  if (act === 'delete') {
    if (!confirm(`Delete the agent “${a.name}”? Its tasks stay in the list as ordinary runs, and their branches stay in your repo.`)) return;
    try { await sendAgent('DELETE', `/${a.id}`); chooseAgent(null); refresh(); } catch (err) { alert(err.message); }
  }
});

let editingAgent = null;
async function initAgentDialog() {
  const f = $('agentForm');
  $('agentClose').addEventListener('click', () => $('agentDialog').close());
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    const link = chatProjects().find((p) => p.id === body.project);
    body.project = link ? { id: link.id, name: link.name } : (body.project && editingAgent?.project?.id === body.project ? editingAgent.project : null);
    for (const k of ['maxSteps', 'maxMinutes', 'maxCost', 'maxTier']) if (body[k] === '') body[k] = null;
    body.escalate = f.elements.escalate.checked;
    $('agentMsg').textContent = 'Saving…';
    try {
      const saved = editingAgent ? await sendAgent('PATCH', `/${editingAgent.id}`, body) : await sendAgent('POST', '', body);
      $('agentMsg').textContent = '';
      $('agentDialog').close();
      if (body.repo) { rememberRepo(body.repo); renderRecent(); }
      await refresh();
      chooseAgent(saved.id);
    } catch (err) { $('agentMsg').textContent = err.message; }
  });
  try {
    const { workflows } = await (await fetch('api/workflows')).json();
    $('agentWorkflow').innerHTML = workflows.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} (${w.stages.length} ${w.stages.length === 1 ? 'stage' : 'stages'})</option>`).join('');
  } catch { $('agentWorkflow').innerHTML = '<option value="general">Do the task</option>'; }
  try {
    const { profiles } = await (await fetch('api/profiles')).json();
    $('agentProfile').insertAdjacentHTML('beforeend', profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') + '<option value="auto">Jev picks (auto)</option>');
  } catch { /* the default routing is enough */ }
}

function openAgentDialog(agent) {
  editingAgent = agent;
  const f = $('agentForm');
  $('agentDialogTitle').textContent = agent ? `Edit ${agent.name}` : 'New agent';
  $('agentMsg').textContent = '';
  const projects = chatProjects();
  const linked = agent?.project && !projects.some((p) => p.id === agent.project.id) ? [{ id: agent.project.id, name: `${agent.project.name || 'A project'} (not in this browser)` }] : [];
  $('agentProject').innerHTML = '<option value="">None</option>' + [...projects, ...linked].map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const v = agent || { name: '', repo: recentRepos()[0] || '', instructions: '', workflow: 'general', profile: '', effort: '', maxSteps: '', maxMinutes: '', maxCost: '', project: null };
  f.elements.name.value = v.name;
  f.elements.repo.value = v.repo;
  f.elements.instructions.value = v.instructions || '';
  f.elements.workflow.value = v.workflow || 'general';
  f.elements.profile.value = v.profile || '';
  f.elements.effort.value = v.effort || '';
  f.elements.sandbox.value = v.sandbox || '';
  f.elements.maxSteps.value = v.maxSteps ?? '';
  f.elements.maxMinutes.value = v.maxMinutes ?? '';
  f.elements.maxCost.value = v.maxCost ?? '';
  f.elements.maxTier.value = v.maxTier || '';
  f.elements.escalate.checked = v.escalate !== false;
  f.elements.project.value = v.project?.id || '';
  $('agentDialog').showModal();
  f.elements.name.focus();
}
