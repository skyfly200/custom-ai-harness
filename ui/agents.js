// Agents page: named, long-lived agents and their tasks, plus one-off runs. Start
// a task, watch it work, answer its questions about risky commands, and look at
// what it changed.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['queued', 'running', 'waiting']);
// Retry is for a run that went wrong; Continue is for one that only ran out of steps or time
const RETRYABLE = new Set(['done', 'failed', 'stopped']);
// interrupted: the runner or its sandbox was cut off; stopped: a person pressed Stop. Both can be picked up where they left off
const CONTINUABLE = new Set(['incomplete', 'interrupted', 'stopped']);
const DEBUGGABLE = new Set(['failed', 'stopped']);
const TAGS = { done: 'ok', running: '', queued: '', waiting: 'warn', incomplete: 'warn', interrupted: 'warn', failed: 'bad', stopped: 'warn' };
const NOTE_FOR = { done: 'finished', waiting: 'needs you' };
// a run stopped at its cost limit is "incomplete" to the runner; say why
const statusWord = (r) => (r.status === 'incomplete' && r.outOfBudget ? 'cost limit' : NOTE_FOR[r.status] || r.status);

let selected = location.hash.slice(1) === 'settings' ? null : location.hash.slice(1) || null;
let runs = [];
let agents = [];
let inSettings = location.hash === '#settings'; // the agent settings page: GitHub and the sandboxes
let githubOn = null;   // GitHub connected (null: not known yet)
let inAgent = false;   // false: the floating-orbs home; true: one agent's page (agentSel null = the default agent)
let layout = (() => { try { return localStorage.getItem('harness-run-layout') === 'stack' ? 'stack' : 'side'; } catch { return 'side'; } })();
let peekId = null;     // the orb whose details card is open by tap
let agentSel = null;   // the agent whose tasks are shown, or null for every run
let busy = false;
let lastShown = null;  // the run the detail pane last drew
let hosted = false;    // a shared server: GitHub repos, your own runs only, push to GitHub
let openDetails = new Set(); // which <details> are open, kept across redraws

async function api(path, options) {
  const res = await fetch(`api/runs${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { disabled: body.disabled });
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
// which models answered: name, calls, tokens and cost, so a surprising bill can be traced to a model
const modelsFact = (r) => {
  const rows = Object.entries(r.models || {}).sort((a, b) => b[1].calls - a[1].calls);
  if (!rows.length) return '';
  const title = rows.map(([m, v]) => `${m}: ${v.calls} calls, ${(v.in + v.out).toLocaleString()} tokens, ${Costs.usd(v.cost)}`).join('\n');
  return `<span title="${esc(title)}">Models ${rows.slice(0, 3).map(([m, v]) => `${esc(m.split('/').pop())} ×${v.calls}`).join(', ')}${rows.length > 3 ? ` +${rows.length - 3}` : ''}</span>`;
};
const agentSpend = (id) => {
  const own = runs.filter((r) => r.agent === id);
  const ids = new Set(own.map((r) => r.id));
  const all = runs.filter((r) => ids.has(r.id) || ids.has(r.parent));
  const cost = all.reduce((n, r) => n + (r.cost || 0), 0), unpriced = all.reduce((n, r) => n + (r.unpricedCalls || 0), 0);
  return (cost || !unpriced ? Costs.usd(cost) : '$?') + (unpriced ? '+' : '');
};
const shown = () => (agentSel ? runs.filter((r) => r.agent === agentSel) : runs.filter((r) => !r.agent));

// Redraw only when the markup changed, so the refresh every 1.5 s doesn't replay the newest line's animation
// or restart the orb and scroll position when nothing is new
const lastHtml = new Map();
function setHtml(id, html) {
  if (lastHtml.get(id) === html) return false;
  lastHtml.set(id, html);
  $(id).innerHTML = html;
  return true;
}

function renderList() {
  const list = shown();
  renderPrompts();
  $('listTitle').textContent = agentSel ? `${agentOf(agentSel)?.name || 'Agent'}: tasks` : 'Runs';
  if (!list.length) { setHtml('list', `<p class="muted">${agentSel ? 'No tasks yet. Press New run to give it one.' : 'No runs yet.'}</p>`); return; }
  setHtml('list', list.map((r) => `<button class="run-item${r.id === selected ? ' on' : ''}" data-id="${esc(r.id)}">
    <i class="sdot ${TAGS[r.status] || 'live'}${ACTIVE.has(r.status) ? ' pulse' : ''}" title="${esc(statusWord(r))}"></i>
    <span class="goal">${esc(r.goal.split('\n')[0])}</span>
    <span class="meta">${!agentSel && agentOf(r.agent) ? `<span class="agent-tag">${AgentIcon.icon(agentOf(r.agent))}${esc(agentOf(r.agent).name)}</span> · ` : ''}${r.kind === 'swarm' ? '<span class="tag">swarm</span> ' : r.kind === 'chatdev' ? '<span class="tag">chatdev</span> ' : ''}${r.parent ? '↳ ' : ''}<span class="tag ${TAGS[r.status] || ''}">${esc(statusWord(r))}</span> ${esc(r.repo.split(/[\\/]/).pop())} · ${ago(r.created)}</span></button>`).join(''));
}

function eventHtml(e) {
  const time = `<span class="t">${new Date(e.t).toLocaleTimeString()}</span>`;
  const key = `${e.t}-${e.type}-${e.name || ''}`;
  const open = (k) => (openDetails.has(k) ? ' open' : '');
  if (e.type === 'model') return `<div class="ev model">${time}${e.text ? esc(e.text) : '<span class="muted">(called tools)</span>'} <span class="muted">${esc(e.model || '')}</span></div>`;
  if (e.type === 'tool') {
    const a = e.args || {};
    const brief = a.command ?? a.path ?? (typeof a.summary === 'string' ? a.summary : '') ?? '';
    return `<div class="ev tool">${time}<strong>${esc(e.name)}</strong> <code>${esc(String(brief).slice(0, 200))}</code>${e.why ? ` <span class="why">${esc(e.why)}</span>` : ''}</div>`;
  }
  if (e.type === 'result') return `<div class="ev"><details data-k="${esc(key)}"${open(key)}><summary>${time}result: ${esc((e.text || '').split('\n')[0].slice(0, 120))}</summary><pre>${esc(e.text)}</pre></details></div>`;
  if (e.type === 'approval_needed') return `<div class="ev approval_needed">${time}Waiting for you: <code>${esc(e.text)}</code> (${esc(e.reason)})</div>`;
  if (e.type === 'approval') return `<div class="ev decided">${time}${e.allowed ? 'Allowed' : 'Declined'}: <code>${esc(e.text)}</code></div>`;
  if (e.type === 'plan') return `<div class="ev stage">${time}<strong>Plan</strong><pre>${esc(e.text)}</pre></div>`;
  if (e.type === 'stage') return `<div class="ev stage">${time}<strong>${esc(e.text)}</strong></div>`;
  if (e.type === 'note') return `<div class="ev">${time}${esc(e.text)}</div>`;
  if (e.type === 'warning') return `<div class="ev warning">${time}<strong>⚠ ${esc(e.text)}</strong></div>`;
  return '';
}

function renderDetail(run) {
  if (!run) { setHtml('detail', `<p class="muted">Pick a ${agentSel ? 'task' : 'run'} to see what the agent did.</p>`); return; }
  const active = ACTIVE.has(run.status);
  const r = run.result;
  const diffOpen = openDetails.has('diff');
  const changed = setHtml('detail', `
    <div class="facts">${run.plan ? '<span class="tag plan" title="Plan only: nothing was changed or committed">Plan only</span>' : ''}<span>Repo <code>${esc(run.repo)}</code></span>${run.plan ? '' : `<span>Branch <code>${esc(run.branch)}</code></span>`}${run.workflowName ? `<span>Workflow ${esc(run.workflowName)}${run.stage ? ` · ${esc(run.stage)}` : ''}</span>` : ''}<span title="${run.maxSteps ? '' : 'No step limit: only the finish call, the minutes and the cost limit end it'}">Steps ${run.steps}${run.maxSteps ? ` of ${run.maxSteps}` : ' · no limit'}</span><span>${(run.tokens.in + run.tokens.out).toLocaleString()} tokens</span><span title="${run.unpricedCalls ? `${run.unpricedCalls} model call(s) had no known price, so the real cost is higher` : 'Priced like the Usage page'}">Cost ${runCost(run)}${run.maxCost ? ` of ${Costs.usd(run.maxCost)} limit` : ''}</span>${modelsFact(run)}${run.model ? `<span title="Every call went to this model, no routing">Model ${esc(run.model)}</span>` : run.profile ? `<span>Routing ${esc(run.profile)}</span>` : ''}${run.effort ? `<span>Effort ${esc(run.effort)}</span>` : ''}${run.maxTier ? `<span>Highest tier ${esc(run.maxTier)}</span>` : ''}${run.bumps ? `<span title="A failure made this run ask for a stronger model">Escalated ${run.bumps}×</span>` : ''}${run.sandbox && run.sandbox !== 'local' ? `<span>Sandbox ${esc(SANDBOX_NAMES[run.sandbox] || run.sandbox)}${run.sandboxId ? ` <code>${esc(run.sandboxId)}</code>` : ''}</span>` : ''}</div>
    ${run.agent && agentOf(run.agent) ? `<p class="muted">A task of <a href="#${esc(run.agent)}" data-agent="${esc(run.agent)}">${esc(agentOf(run.agent).name)}</a>${run.source?.chat ? `, handed over from the chat <a href="chat#c=${encodeURIComponent(run.source.chat.id)}">${esc(run.source.chat.title || 'a chat')}</a>` : ''}.</p>` : run.source?.chat ? `<p class="muted">Handed over from the chat <a href="chat#c=${encodeURIComponent(run.source.chat.id)}">${esc(run.source.chat.title || 'a chat')}</a>.</p>` : ''}
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
      ${r.commit ? `<p class="muted">${r.salvaged ? 'The run stopped early; its unfinished work was saved as a commit. ' : ''}Saved on ${hosted ? 'this server' : 'your repo'} as branch <code>${esc(run.branch)}</code>, so it is kept after the sandbox ends.</p>` : ''}
      ${run.pr ? `<p>Pull request: <a href="${esc(run.pr.url)}" target="_blank" rel="noopener">#${esc(run.pr.number)} into ${esc(run.pr.base)}</a></p>` : ''}
      ${r.commit && hosted ? `<p class="muted">${run.pushed ? `Pushed to GitHub: <a href="${esc(run.pushed.url)}" target="_blank" rel="noopener">${esc(run.branch)}</a> · <a href="${esc(run.pushed.compare)}" target="_blank" rel="noopener">open a pull request</a>` : 'The branch is only on this server so far. Push it to your GitHub repo to review it there.'}</p><details data-k="diff"${diffOpen ? ' open' : ''}><summary>Show the changes</summary><pre id="diffText">Loading…</pre></details>` : r.commit ? `<p class="muted">Review it in your repo: <code>git diff ${esc(run.base.slice(0, 10))}..${esc(run.branch)}</code>, then push the branch when you are happy.</p><details data-k="diff"${diffOpen ? ' open' : ''}><summary>Show the changes</summary><pre id="diffText">Loading…</pre></details>` : ''}</div>` : ''}
    <div class="actions">${active
      ? `${run.legs || run.carriesOn ? '<span class="muted">Carrying on…</span> ' : ''}<button data-act="stop">Stop</button>`
      : `${hosted && r?.commit && !run.parent ? `${githubOn === false ? `<a class="btn primary" href="#settings" data-hint="Pushing and pull requests need your GitHub connection. Connect it in Agent settings">Connect GitHub to push</a>` : `<button data-act="push" class="primary" data-hint="Pushes ${esc(run.branch)} to the GitHub repo, using your token">${run.pushed ? 'Push again' : 'Push branch to GitHub'}</button><button data-act="pr" data-hint="Pushes the branch and opens a pull request for it on GitHub, using your token">${run.pr ? 'Update pull request' : 'Open pull request'}</button>`}` : ''}${r?.commit && !run.parent ? '<button data-act="patch" data-hint="Downloads the whole change as a patch file you can apply with git apply">Download patch</button>' : ''}<button data-act="remove" data-hint="Removes the workspace and this record. The branch stays in your repo">Delete run</button>${canContinue(run) ? `<button data-act="continue"${run.status === 'interrupted' ? ' class="primary"' : ''} data-hint="${run.status === 'interrupted' ? 'The run was cut off. This carries it on in the same branch from its last saved commit, told what was interrupted' : run.status === 'stopped' ? 'Carries the stopped run on in the same branch, from what it had committed, with a full set of steps and minutes again' : 'Carries this run on in the same branch, from what the earlier part committed, with a full set of steps and minutes again'}">Continue</button>` : ''}${RETRYABLE.has(run.status) && !run.parent && run.kind !== 'swarm' ? '<button data-act="retry" data-hint="Starts the same task again from the same commit, on a fresh branch">Retry run</button>' : ''}${DEBUGGABLE.has(run.status) && !run.parent ? '<button data-act="debug" data-hint="Starts it again and tells the agent what went wrong this time: the error, the failed tests, the last things it did">Auto debug</button>' : ''}`}<span class="export-btns"><button data-act="export" data-hint="Downloads everything about this run as one JSON file: the prompt, settings, every step with the model's words, tool calls and results, tokens, cost, routing and the outcome. Secrets are blanked">Export run</button><button data-act="export-md" data-hint="The same as a readable Markdown transcript">Export as text</button><button data-act="export-copy" data-hint="Copies the readable transcript so you can paste it into a chat to ask what went wrong">Copy for debugging</button></span></div>`);
  if (changed && r?.commit && diffOpen) loadDiff(run.id);
}

async function loadDiff(id) {
  try {
    const res = await fetch(`api/runs/${id}/diff`);
    const el = $('diffText');
    if (el) el.textContent = (await res.text()) || '(no changes)';
  } catch { /* leave it */ }
}

// the terminal and trace live outside the detail pane, which is redrawn on every refresh
let runTerminal = null;
let rtab = null;           // 'term' | 'trace'; null: the terminal once the agent has run a command, else the trace
let autoScroll = true;     // follow the newest line in the visible view
let termHooked = false;
let quietUntil = 0;        // scroll events we caused ourselves must not switch auto-scroll off
const hasCommands = (run) => Boolean(run && run.events.some((e) => e.type === 'tool' && e.name === 'run_command'));
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;
const scrollEnd = (el) => { quietUntil = Date.now() + 150; el.scrollTop = el.scrollHeight; };
function currentTab(run) { return rtab || (hasCommands(run) ? 'term' : 'trace'); }
function drawTerminal(run) {
  const tab = currentTab(run);
  $('rtabTerm').classList.toggle('on', tab === 'term');
  $('rtabTrace').classList.toggle('on', tab === 'trace');
  $('termPanel').hidden = tab !== 'term';
  $('tracePane').hidden = tab !== 'trace';
  if (!run) { runTerminal?.update(null); return; }
  runTerminal ||= window.RunTerminal?.mount($('termHost'));
  runTerminal?.update(run);
  const term = runTerminal?.term;
  if (term && !termHooked) {
    termHooked = true;
    term.onScroll(() => {
      if (Date.now() < quietUntil || $('termPanel').hidden) return;
      const b = term.buffer.active;
      setAuto(b.viewportY >= b.baseY);
    });
  }
  if (term && tab === 'term' && autoScroll) { quietUntil = Date.now() + 150; term.scrollToBottom(); }
}
function setAuto(on) { autoScroll = on; $('autoScroll').checked = on; }
function showTab(tab) {
  rtab = tab;
  drawTerminal(lastRun);
  if (tab === 'term') setTimeout(() => runTerminal?.refit(), 0);
  if (autoScroll) toBottom();
}
function toBottom() {
  if (currentTab(lastRun) === 'term') { quietUntil = Date.now() + 150; runTerminal?.term?.scrollToBottom(); } else scrollEnd($('traceList'));
}
$('rtabTerm').addEventListener('click', () => showTab('term'));
$('rtabTrace').addEventListener('click', () => showTab('trace'));
$('autoScroll').addEventListener('change', (e) => { autoScroll = e.target.checked; if (autoScroll) toBottom(); });
$('toBottom').addEventListener('click', () => { setAuto(true); toBottom(); });
function setFull(on) {
  $('rightCol').classList.toggle('full', on);
  document.body.classList.toggle('has-full', on);
  $('fullBtn').textContent = on ? '✕' : '⛶';
  $('fullBtn').setAttribute('aria-label', on ? 'Close full screen' : 'Full screen');
  setTimeout(() => runTerminal?.refit(), 0);
}
$('fullBtn').addEventListener('click', () => setFull(!$('rightCol').classList.contains('full')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('rightCol').classList.contains('full') && !document.querySelector('dialog[open]')) setFull(false); });

// Trace: the run's events, filtered and searched
const tf = { type: 'all', tool: '', stage: '', errors: false, q: '' };
let hits = [], hitAt = -1, traceRun = null;
function fillOptions(sel, values, any) {
  const keep = sel.value;
  const html = `<option value="">${any}</option>${values.map((v) => `<option value="${esc(v)}">${esc(v.length > 40 ? `${v.slice(0, 39)}…` : v)}</option>`).join('')}`;
  if (lastHtml.get(sel.id) !== html) { lastHtml.set(sel.id, html); sel.innerHTML = html; if (values.includes(keep)) sel.value = keep; }
}
function drawTrace(run) {
  const list = $('traceList');
  if (!run) { traceRun = null; setHtml('traceList', ''); $('tfCount').textContent = ''; return; }
  const items = RunView.annotate(run.events);
  fillOptions($('tfTool'), [...new Set(items.map((i) => i.tool).filter(Boolean))], 'Any tool');
  fillOptions($('tfStage'), [...new Set(items.map((i) => i.stage).filter(Boolean))], 'Any stage');
  const shownItems = RunView.filterEvents(items, tf);
  const body = shownItems.map(({ e }) => eventHtml(e)).join('');
  const fresh = traceRun !== run.id;
  traceRun = run.id;
  const html = body || `<p class="muted">${items.length ? 'No events match the filter.' : 'Nothing yet.'}</p>`;
  const top = list.scrollTop;
  const changed = setHtml('traceList', html);
  if (changed || fresh) {
    markHits();
    if (fresh) { setAuto(true); }
    if (autoScroll) scrollEnd(list); else { quietUntil = Date.now() + 150; list.scrollTop = top; }
  }
  $('tfCount').textContent = tf.q ? (hits.length ? `${hitAt + 1}/${hits.length}` : 'no match') : (shownItems.length === items.length ? `${items.length}` : `${shownItems.length} of ${items.length}`);
}
// wrap each search match in <mark>; the text inside closed result boxes counts too
function markHits() {
  hits = [];
  const q = tf.q.toLowerCase();
  if (!q) { hitAt = -1; return; }
  const walker = document.createTreeWalker($('traceList'), NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.toLowerCase().includes(q)) nodes.push(n);
  for (const node of nodes) {
    const text = node.nodeValue, low = text.toLowerCase(), frag = document.createDocumentFragment();
    let at = 0;
    for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
      frag.append(text.slice(at, i));
      const m = document.createElement('mark');
      m.className = 'hit'; m.textContent = text.slice(i, i + q.length);
      frag.append(m); hits.push(m);
      at = i + q.length;
    }
    frag.append(text.slice(at));
    node.replaceWith(frag);
  }
  hitAt = hits.length ? Math.min(Math.max(hitAt, 0), hits.length - 1) : -1;
  markCurrent(false);
}
function markCurrent(scroll) {
  hits.forEach((m, i) => m.classList.toggle('cur', i === hitAt));
  const m = hits[hitAt];
  if (!m || !scroll) return;
  const box = m.closest('details');
  if (box && !box.open) box.open = true;
  setAuto(false);
  quietUntil = Date.now() + 250;
  m.scrollIntoView({ block: 'center' });
}
function stepHit(d) {
  if (!hits.length) return;
  hitAt = (hitAt + d + hits.length) % hits.length;
  markCurrent(true);
  $('tfCount').textContent = `${hitAt + 1}/${hits.length}`;
}
function redrawTrace() { lastHtml.delete('traceList'); drawTrace(lastRun); }
for (const [id, key] of [['tfType', 'type'], ['tfTool', 'tool'], ['tfStage', 'stage']]) $(id).addEventListener('change', (e) => { tf[key] = e.target.value; hitAt = 0; redrawTrace(); });
$('tfErrors').addEventListener('change', (e) => { tf.errors = e.target.checked; hitAt = 0; redrawTrace(); });
$('tfSearch').addEventListener('input', (e) => { tf.q = e.target.value.trim(); hitAt = 0; redrawTrace(); if (hits.length) markCurrent(true); });
$('tfSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } });
$('tfNext').addEventListener('click', () => stepHit(1));
$('tfPrev').addEventListener('click', () => stepHit(-1));
$('traceList').addEventListener('scroll', () => { if (Date.now() >= quietUntil) setAuto(nearBottom($('traceList'))); });
$('traceList').addEventListener('toggle', (e) => {
  const k = e.target.dataset?.k;
  if (!k) return;
  if (e.target.open) openDetails.add(k); else openDetails.delete(k);
}, true);

// The status section: what the run is doing now and what it has done, in plain words
let lastRun = null;
let promptOpen = false;   // the whole prompt is shown, not the first lines
const canContinue = (run) => CONTINUABLE.has(run.status) && !run.parent && run.kind !== 'swarm' && run.kind !== 'chatdev';
const CUT_WHY = { restart: 'the runner restarted', shutdown: 'the runner was shutting down for a restart or deploy', sandbox: 'its cloud sandbox ended' };
// what the card says about a run that was cut off, or that started itself again after one
function cutLine(run) {
  const auto = run.resumedAuto && ACTIVE.has(run.status) ? `<span class="tag ok">resumed automatically</span> Attempt ${run.resumedAuto.attempt} of ${run.resumedAuto.of}, after ${esc(CUT_WHY[run.resumedAuto.after] || 'an interruption')}.` : '';
  if (auto) return `<div class="sc-cut">${auto}</div>`;
  if (run.status === 'interrupted') {
    const will = run.autoContinue && (run.autoAttempts || 0) < (run.autoMax || 3) ? `It will resume by itself${run.interrupted?.reason === 'sandbox' ? ' in a moment' : ' when the runner is back'} (attempt ${(run.autoAttempts || 0) + 1} of ${run.autoMax || 3}).` : run.autoContinue ? `It has already resumed itself ${run.autoAttempts || 0} times, so it waits for you.` : 'It has not resumed.';
    return `<div class="sc-cut">Its work up to the last save is kept. ${will} ${canContinue(run) ? '<button data-act="continue" class="primary">Continue</button>' : ''}</div>`;
  }
  if (run.status === 'stopped' && canContinue(run)) return `<div class="sc-cut">Nothing is lost: Continue picks it up from its last commit. <button data-act="continue">Continue</button></div>`;
  return '';
}
function drawStatus(run) {
  lastRun = run;
  if (!run) { setHtml('statusCard', ''); return; }
  const active = ACTIVE.has(run.status);
  const workers = (run.children || []).map((id) => runs.find((x) => x.id === id)).filter(Boolean);
  const tag = run.status === 'incomplete' && run.outOfBudget ? 'cost limit' : run.status;
  const long = run.goal.length > 220 || run.goal.split('\n').length > 3;
  if (lastShown !== run.id) promptOpen = false;
  setHtml('statusCard', `<div class="sc-top">${AgentIcon.orb(agentOf(run.agent), `${active ? 'live' : ''}${run.status === 'waiting' ? ' wait' : ''}`.trim())}<span class="tag ${TAGS[run.status] || ''}">${esc(tag)}</span><span class="sc-quick">${esc(RunView.quickLine(run))}</span><span class="muted sc-when">started ${ago(run.created)}</span></div>
    ${cutLine(run)}
    <div class="sc-prompt${long && !promptOpen ? ' clip' : ''}" id="scPrompt" title="The prompt for this run">${esc(run.goal)}</div>${long ? `<button type="button" class="linklike" id="scMore">${promptOpen ? 'Show less' : 'Show all'}</button>` : ''}
    <p class="sc-summary">${esc(RunView.summarize(run, workers))}</p>`);
}
$('statusCard').addEventListener('click', async (e) => {
  if (e.target.closest('[data-act="continue"]') && selected) {
    try { await post(`/${selected}/continue`); } catch (err) { ui.toast(err.message, { kind: 'error' }); }
    refresh();
    return;
  }
  if (!e.target.closest('#scMore')) return;
  promptOpen = !promptOpen;
  lastHtml.delete('statusCard');
  drawStatus(lastRun);
});

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
  if (!selected || !await ui.confirm(ask)) return;
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
      if (!await ui.confirm(`${body.error}\n\nRun this command in the workspace?\n${command}`)) { $('previewMsg').textContent = ''; return; }
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
    applyView();
    if (selected) {
      const run = await api(`/${selected}`).catch(() => null);
      // the page itself never scrolls for a run: the trace and terminal follow the newest line, the left side starts at the top
      const fresh = lastShown !== selected;
      drawStatus(run);
      renderDetail(run);
      lastShown = selected;
      if (fresh) $('leftCol').scrollTop = 0;
      drawTerminal(run);
      drawTrace(run);
      drawPreview(run);
      drawShip(run);
      drawFollow(run);
    } else { drawStatus(null); drawTerminal(null); drawTrace(null); drawPreview(null); drawShip(null); drawFollow(null); }
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $('down').hidden = false;
    $('down').textContent = err.message;
    document.body.classList.toggle('runs-off', Boolean(err.disabled));
    $('updated').textContent = err.disabled ? 'Agents are off' : 'Task runner unreachable';
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
  applyView();
  renderList();
  refresh();
});

$('detail').addEventListener('click', async (e) => {
  const goAgent = e.target.closest('[data-agent]')?.dataset.agent;
  if (goAgent) { e.preventDefault(); chooseAgent(goAgent); return; }
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (go) { e.preventDefault(); selected = go; location.hash = go; openDetails = new Set(); applyView(); renderList(); refresh(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !selected) return;
  try {
    if (act === 'allow') await post(`/${selected}/approve`, { allow: true });
    if (act === 'decline') await post(`/${selected}/approve`, { allow: false });
    if (act === 'stop') await post(`/${selected}/stop`);
    if (act === 'push') {
      if (!await ui.confirm(`Push ${runById(selected)?.branch || 'this branch'} to your GitHub repo? It uses your connected GitHub account.`)) return;
      await post(`/${selected}/push`);
      ui.toast('Pushed to GitHub.');
    }
    if (act === 'pr') {
      if (!await ui.confirm(`Push ${runById(selected)?.branch || 'this branch'} and open a pull request on GitHub? It is never merged for you.`)) return;
      const pr = await post(`/${selected}/pr`);
      ui.toast(`Pull request #${pr.number} is open.`);
    }
    if (act === 'patch') await downloadPatch(selected);
    if (act === 'export' || act === 'export-md') await downloadExport(selected, act === 'export-md');
    if (act === 'export-copy') {
      await navigator.clipboard.writeText(await fetchExport(selected, true));
      ui.toast('Copied. Paste it wherever you want the run looked at.');
    }
    if (act === 'retry' || act === 'debug') {
      const made = await post(`/${selected}/retry`, { debug: act === 'debug' });
      selected = made.id; location.hash = made.id; openDetails = new Set();
    }
    // a continue is the same run, so the page stays on it
    if (act === 'continue') await post(`/${selected}/continue`);
    if (act === 'remove') {
      if (!await ui.confirm('Delete this run? Its branch stays in your repo.')) return;
      await api(`/${selected}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
      selected = null; location.hash = '';
      renderDetail(null);
    }
  } catch (err) { ui.toast(err.message, { kind: 'error' }); }
  refresh();
});

const runById = (id) => runs.find((r) => r.id === id);
async function fetchExport(id, md) {
  const res = await fetch(`api/runs/${id}/export${md ? '?format=md' : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // a runner started before the export existed answers 404 with no JSON error
    throw new Error(body?.error || (res.status === 404 ? 'the task runner does not know the export yet: restart it (npm run all) and try again' : `could not export the run (HTTP ${res.status})`));
  }
  return res.text();
}
async function downloadExport(id, md) {
  const url = URL.createObjectURL(new Blob([await fetchExport(id, md)], { type: md ? 'text/markdown' : 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `run-${id}.${md ? 'md' : 'json'}` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadPatch(id) {
  const res = await fetch(`api/runs/${id}/patch`);
  if (!res.ok) throw new Error(`could not get the patch (HTTP ${res.status})`);
  const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/x-diff' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${id}.patch` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Ask the agent: a message to a run that has ended starts it again on the same branch
let followFor = null;
function drawFollow(run) {
  const ok = run && !ACTIVE.has(run.status) && !run.parent && !['swarm', 'chatdev'].includes(run.kind) && !$('followForm').dataset.busy;
  $('followPanel').hidden = !run || run.parent || ['swarm', 'chatdev'].includes(run.kind) || ACTIVE.has(run.status);
  if (!ok) return;
  if (followFor !== run.id) { followFor = run.id; $('followText').value = ''; $('followMsg').textContent = ''; }
  $('followSaved').textContent = run.result?.commit
    ? `The work is saved on branch ${run.branch}${hosted ? ' on this server' : ''}; a message here starts the agent again from its last commit${hosted ? ', and Push or Open pull request above sends it to GitHub' : ''}.`
    : 'No commit yet, so the branch is as it started. A message here starts the agent again with what it did as context.';
}
$('followChips').addEventListener('click', (e) => { const say = e.target.closest('[data-say]')?.dataset.say; if (say) { $('followText').value = say; $('followText').focus(); } });
$('followForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('followText').value.trim();
  if (!message || !selected) return;
  $('followForm').dataset.busy = '1';
  $('followSend').disabled = true;
  try {
    await post(`/${selected}/continue`, { message });
    $('followText').value = '';
    $('followMsg').textContent = '';
    ui.toast('Sent. The agent is picking the run up again.');
  } catch (err) { ui.toast(err.message, { kind: 'error' }); }
  delete $('followForm').dataset.busy;
  $('followSend').disabled = false;
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
    if (!await ui.confirm(`Write ${plan.files.length} files into ${plan.repo}/${plan.folder}?\n\n${plan.files.map((x) => `· ${x.name}`).join('\n')}`)) { msg.textContent = ''; return; }
    const made = await ticketCall('files', { ...body, confirm: true });
    msg.textContent = `Wrote ${made.files.length} files to ${made.relative}. Commit them when you are happy.`;
  } catch (err) { msg.textContent = err.message; }
});
$('loadTickets').addEventListener('click', async () => {
  const f = $('newRun'), msg = $('ticketsMsg');
  const folder = await ui.prompt('Folder inside the repo, for example wayfinder/add-export');
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
  if (body.model) delete body.profile; // one model directly replaces the routing
  body.escalate = f.elements.escalate?.checked ? '1' : '0';
  body.autoContinue = f.elements.autoContinue?.checked ? '1' : '0';
  try {
    $('startMsg').textContent = 'Starting…';
    if (body.workflow === 'auto') {
      const pick = lastPick?.goal === body.goal ? lastPick : await pickWorkflow(body.goal);
      body.workflow = pick?.id || 'general';
    }
    let run;
    if (agentSel) {
      const task = { goal: body.goal, plan: body.plan === '1', ...(body.model ? { model: body.model } : body.profile ? { profile: body.profile } : {}), ...(body.effort ? { effort: body.effort } : {}), ...(body.maxTier ? { maxTier: body.maxTier } : {}), ...(body.maxSteps !== undefined ? { maxSteps: body.maxSteps } : {}), ...(body.maxMinutes !== undefined ? { maxMinutes: body.maxMinutes } : {}), ...(body.maxCost !== undefined ? { maxCost: body.maxCost } : {}), ...(body.autoContinue === '1' ? { autoContinue: true, ...(body.autoContinueMax ? { autoContinueMax: body.autoContinueMax } : {}) } : {}) };
      run = await sendAgent('POST', `/${agentSel}/tasks`, task);
    } else run = await post('', body);
    if (!agentSel && body.repo) { rememberRepo(body.repo); renderRecent(); }
    selected = run.id; location.hash = run.id; openDetails = new Set();
    f.elements.goal.value = '';
    $('startMsg').textContent = '';
    $('runDialog').close();
    applyView(); renderList();
    refresh();
  } catch (err) { $('startMsg').textContent = err.message; }
});

// Workflows: the picker asks Jev about the goal a moment after you stop typing
let lastPick = null;
let workflowList = [];
let pickTimer = null;
const nameOf = (id) => workflowList.find((w) => w.id === id)?.name || id;

async function pickWorkflow(goal) {
  const res = await fetch('api/workflows/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = await res.json();
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
  pickTimer = setTimeout(() => { if ($('workflow').value === 'auto') pickWorkflow(goal).catch(() => {}); }, 700);
}

async function initWorkflows() {
  try {
    const { workflows } = await (await fetch('api/workflows')).json();
    workflowList = workflows;
    $('workflow').insertAdjacentHTML('beforeend', workflows.map((w) => `<option value="${esc(w.id)}" title="${esc(`Fits: ${w.when}. Stages: ${w.stages.map((s) => s.role).join(' → ')}`)}">${esc(w.name)} (${w.stages.length} ${w.stages.length === 1 ? 'stage' : 'stages'})</option>`).join(''));
    $('workflow').insertAdjacentHTML('beforeend', '<option value="swarm">Swarm (several agents at once)</option><option value="chatdev">ChatDev (in a cloud sandbox)</option>');
  } catch { /* auto still works without the list */ }
  $('newRun').elements.goal.addEventListener('input', schedulePick);
  $('workflow').addEventListener('change', () => { applyMode(); $('pickNote').textContent = ''; drawWorkflowHelp(); if ($('workflow').value === 'auto') schedulePick(); });
  $('suggestBtn').addEventListener('click', suggestWorkflow);
  $('wfTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-wf]');
    if (!row) return;
    $('workflow').value = row.dataset.wf;
    $('workflow').dispatchEvent(new Event('change'));
  });
  drawWorkflowHelp();
}

// the plain explanation of the chosen way of working, and a table of all of them to compare
const WF_ORDER = ['auto', ...['quick-answer', 'research', 'review', 'general', 'fix-bug', 'build-feature', 'build-audit', 'refactor', 'audit-refactor', 'change-app'], 'swarm', 'chatdev'];
function wfEntries() {
  const known = workflowList.map((w) => ({ id: w.id, name: w.name, help: RunView.help(w), stages: w.stages.map((x) => x.role) }));
  const extra = [{ id: 'swarm', name: 'Swarm', help: RunView.help('swarm'), stages: ['Planner', 'Workers', 'Reviewer'] }, { id: 'chatdev', name: 'ChatDev', help: RunView.help('chatdev'), stages: [] }];
  const all = [{ id: 'auto', name: 'Jev picks (auto)', help: RunView.help('auto'), stages: [] }, ...known, ...extra];
  return all.sort((a, b) => (WF_ORDER.indexOf(a.id) + 1 || 99) - (WF_ORDER.indexOf(b.id) + 1 || 99));
}
function drawWorkflowHelp() {
  const entries = wfEntries();
  const cur = entries.find((w) => w.id === $('workflow').value) || entries[0];
  const h = cur.help;
  $('wfHelp').innerHTML = `<strong>${esc(cur.name)}</strong>${cur.stages.length ? ` <span class="muted">${esc(cur.stages.join(' → '))}</span>` : ''}
    <p>${esc(h.what)}</p><p><span class="muted">Use it for:</span> ${esc(h.use)}</p>${h.feel ? `<p><span class="muted">Cost and time:</span> ${esc(h.feel)}</p>` : ''}`;
  $('wfTable').innerHTML = entries.map((w) => `<button type="button" class="wfrow${w.id === cur.id ? ' on' : ''}" data-wf="${esc(w.id)}"><strong>${esc(w.name)}</strong><span>${esc(w.help.what)}</span><span class="muted">${esc(w.help.feel || '')}</span></button>`).join('');
}
// Jev reads the prompt and the matching way of working is selected, with the reason in one line
async function suggestWorkflow() {
  const goal = $('newRun').elements.goal.value.trim();
  if (goal.length < 3) { ui.toast('Write the prompt first, then Jev can suggest a way of working.'); $('newRun').elements.goal.focus(); return; }
  clearTimeout(pickTimer);
  const btn = $('suggestBtn');
  btn.disabled = true; btn.textContent = 'Asking Jev…';
  try {
    const r = await pickWorkflow(goal);
    if (!r?.id) throw new Error(r?.note || 'Jev gave no answer');
    $('workflow').value = r.id;
    $('workflow').dispatchEvent(new Event('change'));
    const w = workflowList.find((x) => x.id === r.id);
    $('pickNote').textContent = r.by === 'jev'
      ? `Jev suggests “${nameOf(r.id)}” (${Math.round(r.p * 100)}% sure)${w?.when ? `: your prompt looks like ${w.when}.` : '.'}`
      : `Jev wasn't sure enough to pick a specific one, so “${nameOf(r.id)}” is the safe default.`;
  } catch (err) { ui.toast(`Jev couldn't suggest one: ${err.message}`, { kind: 'error' }); }
  btn.disabled = false; btn.textContent = 'Suggest with Jev';
}

// On a shared server: repos are GitHub repos named owner/name, there is no folder to browse and no local apps
function hostedMode() {
  $('appsBox').hidden = true;
  for (const id of ['browse', 'agentBrowse', 'fileTickets', 'loadTickets']) if ($(id)) $(id).hidden = true;
  for (const id of ['repo', 'agentRepo']) $(id).placeholder = 'owner/name on GitHub, for example skyfly200/my-app';
  $('githubBox').hidden = false;
  loadGithub();
  loadGithubRepos();
}
// Repo fields suggest the person's connected GitHub repos (typing owner/name still works)
async function loadGithubRepos() {
  try {
    const res = await fetch('api/github/repos');
    if (!res.ok) return;
    fillRepoList(((await res.json()).repos || []).map((r) => ({ value: r.full, label: r.private ? 'private' : 'public' })));
  } catch { /* not connected: free typing */ }
}
function fillRepoList(items) {
  $('repoList').innerHTML = items.map((i) => `<option value="${esc(i.value)}">${esc(i.label || '')}</option>`).join('');
}
// Connected: one quiet line. The connect / token / disconnect controls live in a dialog (ui/githubconnect.js)
async function loadGithub() {
  try {
    const j = await (await fetch('api/github/status')).json();
    githubOn = Boolean(j.connected);
    $('githubNote').textContent = j.connected ? `GitHub: connected as ${j.login || 'you'}.` : 'GitHub is not connected. Public repos can be cloned without it; private repos and pushing need it.';
    $('githubManage').textContent = j.connected ? 'Manage' : 'Connect GitHub';
    $('githubManage').classList.toggle('primary', !j.connected);
  } catch (err) { $('githubNote').textContent = err.message; }
}
$('githubManage').addEventListener('click', async () => {
  if (await githubConnect.open({ back: 'agents' })) { loadGithub(); loadGithubRepos(); }
  else loadGithub();
});
// Back from GitHub's sign-in: open nothing, just say how it went
{
  const back = new URLSearchParams(location.search).get('github');
  if (back) {
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => ui.toast(back === 'connected' ? 'GitHub connected.' : `GitHub: ${back === 'unavailable' ? 'not available on this server or account' : back}`, { kind: back === 'connected' ? 'ok' : 'error' }), 300);
  }
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
    hosted = Boolean(r.hosted);
    repos = hosted ? r.repos.map((p) => p.split(/[\\/]/).pop().replace('__', '/')) : r.repos;
    if (hosted) hostedMode();
    else {
      // folders found on this computer (REPO_SCAN_ROOTS, else the runner and file roots, else common code folders)
      try { fillRepoList(((await (await fetch('api/local-repos')).json()).repos || []).map((x) => ({ value: x.path, label: x.name }))); } catch { /* Browse still works */ }
    }
    if (!repos.length && !hosted) $('repo').placeholder = `Paste a path inside ${r.roots.join(' or ') || 'RUNNER_ROOTS'}`;
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
    $('sandboxList').innerHTML = drivers.map((d) => `<li><strong>${esc(d.name)}</strong> ${d.id === def ? '<span class="tag ok">default</span> ' : ''}${d.configured ? '<span class="tag ok">ready</span>' : `<span class="tag">needs ${esc(d.needs)}</span>`}</li>`).join('');
    for (const sel of document.querySelectorAll('.sandbox-select')) sel.innerHTML = `<option value="">Default (${esc(SANDBOX_NAMES[def] || def)})</option>${options}`;
  } catch { /* the runner's default is enough */ }
}

// the new run window
function openRunDialog(goal) {
  applyMode();
  const f = $('newRun');
  if (typeof goal === 'string') f.elements.goal.value = goal;
  $('startMsg').textContent = '';
  $('runDialog').showModal();
  drawWorkflowHelp();
  f.elements.goal.focus();
}
$('runClose').addEventListener('click', () => $('runDialog').close());

// Prompts on the agent page: the saved ones (the prompt library, ui/promptlib.js) and, below them, the prompts of recent runs
let savedPrompts = [];
async function loadPrompts() {
  try { savedPrompts = await window.Prompts.list(); } catch { savedPrompts = []; }
  renderPrompts();
}
function renderPrompts() {
  const saved = savedPrompts.map((p) => ({ title: p.name, text: p.text, saved: true }));
  const seen = new Set(saved.map((p) => p.text.trim()));
  const recent = [...new Map(shown().map((r) => [r.goal.trim(), { title: nameLine(r.goal), text: r.goal, ago: ago(r.created) }])).values()].filter((p) => !seen.has(p.text.trim())).slice(0, 8);
  const items = [...saved, ...recent];
  const row = (p, i) => `<button class="run-item prompt-item" data-pi="${i}" title="Start a run with this prompt"><span class="goal">${esc(p.title)}</span><span class="meta">${p.saved ? '<span class="tag ok">saved</span> ' : `${esc(p.ago)} · `}${esc((p.text || '').replace(/\s+/g, ' ').slice(0, 70))}</span></button>`;
  setHtml('promptList', items.length ? items.map(row).join('') : '<p class="muted">No prompts yet. Save one from the New run window, or write one on the Prompts page.</p>');
  $('promptList')._items = items;
}
$('promptList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pi]');
  const p = b && $('promptList')._items[Number(b.dataset.pi)];
  if (!p) return;
  let text = p.text;
  if (p.saved && window.Prompts.variables(text).length) { text = await window.Prompts.fill(p.title, text); if (text == null) return; }
  openRunDialog(text);
});
$('usePrompt').addEventListener('click', async () => {
  try {
    const got = await window.Prompts.pick({ agent: agentSel || undefined, workflow: $('workflow').value !== 'auto' ? $('workflow').value : undefined });
    if (got) { $('newRun').elements.goal.value = got.text; schedulePick(); $('newRun').elements.goal.focus(); }
  } catch (err) { ui.toast(err.message, { kind: 'error' }); }
});
$('savePrompt').addEventListener('click', async () => {
  const text = $('newRun').elements.goal.value.trim();
  if (!text) { ui.toast('Write the prompt first.'); return; }
  const name = await ui.prompt('Name this prompt', { value: window.Prompts.nameFrom(text) });
  if (!name) return;
  const wf = $('workflow').value;
  try {
    await window.Prompts.save({ name, text, tags: [], suits: { ...(agentSel ? { agent: agentSel } : {}), ...(wf !== 'auto' ? { workflow: wf } : {}) } });
    ui.toast('Saved. Find it on the Prompts page.');
    loadPrompts();
  } catch (err) { ui.toast(err.message, { kind: 'error' }); }
});

async function init() {
  applyView();
  initSandboxes();
  initWorkflows();
  await initRepoPicker();
  try {
    const { profiles } = await (await fetch('api/profiles')).json();
    $('newRun').elements.profile.insertAdjacentHTML('beforeend', profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') + '<option value="auto">Jev picks (auto)</option>');
  } catch { /* the default routing is enough */ }
  fetch('api/models').then((r) => r.json()).then(({ models }) => { $('runModels').innerHTML = (models || []).map((m) => `<option value="${esc(m)}">`).join(''); }).catch(() => {});
  await initAgentDialog();
  const first = location.hash.slice(1);
  if (first === 'settings') { selected = null; inSettings = true; }
  else if (first === 'default') { selected = null; inAgent = true; }
  else if (first.startsWith('a')) { selected = null; agentSel = first; inAgent = true; }
  else if (first) inAgent = true;
  await refresh();
  loadPrompts();
  // a run's link opens on the agent it belongs to
  if (selected && !agentSel) agentSel = runs.find((r) => r.id === selected)?.agent || null;
  applyMode(); applyView();
  renderAgents(); renderList();
  setInterval(refresh, 1500);
}
init();

// ---------------------------------------------------------------------------
// Agents: a bar to pick one, its details, and the dialog to make or edit one
// ---------------------------------------------------------------------------
function renderHero() {
  const live = runs.filter((r) => ACTIVE.has(r.status) && !r.parent);
  const waiting = runs.filter((r) => r.status === 'waiting' || (r.pending && ACTIVE.has(r.status)));
  const working = live.filter((r) => r.status !== 'waiting').length;
  $('heroOrb').className = `orb big${working ? ' live' : ''}${waiting.length ? ' wait' : ''}`;
  $('heroTitle').textContent = waiting.length ? `${waiting.length === 1 ? 'An agent needs' : `${waiting.length} agents need`} you`
    : working ? `${working} ${working === 1 ? 'agent is' : 'agents are'} working` : agents.length ? 'All quiet' : 'Meet your agents';
  $('heroSub').textContent = waiting.length ? 'Open the run to allow or decline what it asked for.'
    : working ? 'Pick one below to watch it. This page refreshes on its own.'
    : agents.length ? 'Open an agent to see its runs and start a new one.'
    : 'An agent is a named helper for one repo. It keeps working on it, task after task.';
}

const nameLine = (s) => String(s || '').split('\n')[0];
function lastRunOf(id) {
  const r = runs.filter((x) => !x.parent && (id ? x.agent === id : !x.agent)).sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
  return r ? `${statusWord(r)} ${ago(r.created)}` : 'none yet';
}
function orbCard(a) {
  const def = !a;
  const doing = def ? 'One-off runs on any repo' : (a.instructions ? nameLine(a.instructions) : `Works on ${a.repo.split(/[\\/]/).filter(Boolean).pop() || a.repo}`);
  return `<span class="orbcard" role="tooltip"><span class="does">${esc(doing)}</span><span class="facts">last: ${esc(lastRunOf(def ? '' : a.id))}</span></span>`;
}
function renderAgents() {
  renderHero();
  const state = (a) => (a.waiting ? 'wait' : a.active ? 'live' : '');
  const bubble = (a, i) => {
    const def = !a;
    const id = def ? 'default' : a.id;
    const st = def ? (runs.some((r) => !r.agent && !r.parent && r.status === 'waiting') ? 'wait' : runs.some((r) => !r.agent && !r.parent && ACTIVE.has(r.status)) ? 'live' : '') : state(a);
    return `<div class="bubble${peekId === id ? ' peek' : ''}${def ? ' def' : ''}" role="listitem" style="--d:${(i * 1.7) % 7}s;--t:${9 + (i * 3) % 5}s;--dx:${(i % 2 ? -1 : 1) * (6 + (i * 5) % 8)}px">
      <button type="button" class="orbbtn" data-aid="${esc(def ? '' : a.id)}" data-bid="${esc(id)}" aria-label="${esc(def ? 'Default' : a.name)}${st === 'wait' ? ', needs you' : st === 'live' ? ', working' : ''}">
        ${AgentIcon.orb(a, st)}<span class="nm">${esc(def ? 'Default' : a.name)}</span></button>${orbCard(a)}</div>`;
  };
  const addB = `<div class="bubble add" role="listitem" style="--d:3s;--t:11s;--dx:7px"><button type="button" class="orbbtn" id="newAgent" aria-label="New agent"><span class="orb plus"><span>+</span></span><span class="nm">New agent</span></button></div>`;
  setHtml('agentChips', [bubble(null, 0), ...agents.map((a, i) => bubble(a, i + 1)), addB].join(''));
  renderLive();
  const a = agentOf(agentSel);
  if (a) {
    $('agentInfo').innerHTML = `<h3>${AgentIcon.icon(a, 'lg')}${esc(a.name)}</h3><div class="facts"><span>Repo <code>${esc(a.repo)}</code></span>${a.moreRepos?.length ? `<span title="Named in every task; the agent works in the repo above">Also ${a.moreRepos.map((r) => `<code>${esc(r)}</code>`).join(' ')}</span>` : ''}<span>Workflow ${esc(nameOf(a.workflow))}</span>${a.model ? `<span>Model ${esc(a.model)}</span>` : a.profile ? `<span>Routing ${esc(a.profile)}</span>` : ''}${a.effort ? `<span>Effort ${esc(a.effort)}</span>` : ''}${a.sandbox ? `<span>Sandbox ${esc(SANDBOX_NAMES[a.sandbox] || a.sandbox)}</span>` : ''}<span title="What this agent's tasks cost, swarm workers included">Spent ${agentSpend(a.id)}</span>${a.project ? `<span>Chat project <a href="chat#project=${encodeURIComponent(a.project.id)}">${esc(projectName(a.project))}</a></span>` : ''}${a.branch ? `<span>Work so far on <code>${esc(a.branch)}</code></span>` : '<span>No work committed yet</span>'}</div>
      ${a.instructions ? `<div class="instr">${esc(a.instructions)}</div>` : ''}
      <div class="actions"><button type="button" class="primary" data-aact="newrun">New run</button><button type="button" data-aact="edit">Edit</button><button type="button" data-aact="delete" data-hint="Removes the agent. Its tasks stay in the list as ordinary runs and their branches stay in your repo">Delete agent</button></div>`;
  } else if (inAgent) {
    $('agentInfo').innerHTML = '<h3>Default</h3><div class="facts"><span>For one-off runs on any repo: start one and say what to do.</span></div><div class="actions"><button type="button" class="primary" data-aact="newrun">New run</button></div>';
  }
}

// the small floating panel of open runs, grouped under their agent
function renderLive() {
  const open = runs.filter((r) => ACTIVE.has(r.status) && !r.parent);
  const panel = $('livePanel');
  panel.hidden = inAgent || !open.length;
  if (!open.length) { lastHtml.delete('livePanel'); return; }
  const groups = new Map();
  for (const r of open) { const k = r.agent || ''; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  setHtml('livePanel', `<strong>Open runs</strong>${[...groups].map(([k, rs]) => `<div class="lg"><span class="lgn">${esc(k ? agentOf(k)?.name || 'Agent' : 'Default')}</span>${rs.map((r) => `<a href="#${esc(r.id)}" data-run="${esc(r.id)}"><i class="sdot ${TAGS[r.status] || 'live'} pulse"></i><span class="g">${esc(nameLine(r.goal))}</span><span class="tag ${TAGS[r.status] || ''}">${esc(statusWord(r))}</span></a>`).join('')}</div>`).join('')}`);
}

// home (floating orbs), one agent's page (its runs and prompts), or one run
function applyView() {
  const view = inSettings ? 'settings' : !inAgent ? 'home' : selected ? 'run' : 'agent';
  document.body.classList.toggle('view-agent', inAgent);
  for (const v of ['home', 'agent', 'run', 'settings']) document.body.classList.toggle(`sub-${v}`, v === view);
  document.body.classList.toggle('view-home', view === 'home');
  $('agentChips').hidden = view !== 'home';
  $('agentsGear').hidden = view !== 'home';
  $('settingsBox').hidden = view !== 'settings';
  $('backBar').hidden = view === 'home';
  $('hero').hidden = true;
  $('agentInfo').hidden = view !== 'agent';
  $('agentGrid').hidden = view !== 'agent';
  $('runPage').hidden = view !== 'run';
  $('layoutNav').hidden = view !== 'run';
  $('settingsLink').hidden = view === 'settings';
  $('backBtn').textContent = view === 'run' ? `← ${agentSel ? agentOf(agentSel)?.name || 'Agent' : 'Default'}` : inSettings && inAgent ? '← Back' : '← All agents';
  $('runView').classList.toggle('side', layout === 'side');
  $('layoutSide').classList.toggle('on', layout === 'side');
  $('layoutStack').classList.toggle('on', layout === 'stack');
  $('appsBox').hidden = view !== 'agent' || Boolean(agentSel) || hosted;
  if (view !== 'run' && $('rightCol').classList.contains('full')) setFull(false);
}
function goHome() {
  inSettings = false; inAgent = false; agentSel = null; selected = null; peekId = null;
  history.pushState(null, '', location.pathname + location.search);
  applyView(); applyMode(); renderAgents(); renderList(); renderDetail(null); drawStatus(null); drawTerminal(null); drawTrace(null); drawPreview(null); drawShip(null); drawFollow(null);
}

// the form is for one-off runs, or for a task of the selected agent
let lastModeAgent;
function applyMode() {
  const f = $('newRun');
  const a = agentOf(agentSel);
  // routing fields stay on for a task, and start from the agent's own
  if (a !== lastModeAgent) {
    f.elements.profile.value = a?.profile || ''; f.elements.model.value = a?.model || ''; f.elements.effort.value = a?.effort || ''; f.elements.maxTier.value = a?.maxTier || '';
    lastModeAgent = a;
  }
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
  inAgent = true; peekId = null;
  selected = null;
  location.hash = agentSel || 'default';
  openDetails = new Set();
  applyView(); applyMode(); renderAgents(); renderList(); renderDetail(null); drawStatus(null); drawTerminal(null); drawTrace(null); loadPrompts();
}
$('agentChips').addEventListener('click', (e) => {
  if (e.target.closest('#newAgent')) return openAgentDialog(null);
  const b = e.target.closest('[data-bid]');
  if (!b) return;
  // touch has no hover: the first tap shows the details card, the second opens the agent
  if (matchMedia('(hover: none)').matches && peekId !== b.dataset.bid) { peekId = b.dataset.bid; lastHtml.delete('agentChips'); renderAgents(); return; }
  chooseAgent(b.dataset.aid);
});
$('agentChips').addEventListener('click', (e) => { if (e.target.closest('.orbcard .open')) chooseAgent(e.target.closest('.bubble').querySelector('[data-aid]').dataset.aid); });
document.addEventListener('click', (e) => { if (peekId && !e.target.closest('.bubble')) { peekId = null; lastHtml.delete('agentChips'); renderAgents(); } });
$('backBtn').addEventListener('click', () => {
  if (inSettings) { inSettings = false; history.pushState(null, '', inAgent ? `#${selected || agentSel || 'default'}` : location.pathname + location.search); applyView(); renderAgents(); renderList(); return; }
  if (inAgent && selected) { selected = null; history.pushState(null, '', `#${agentSel || 'default'}`); applyView(); renderList(); renderDetail(null); drawStatus(null); drawTerminal(null); drawTrace(null); drawPreview(null); drawShip(null); drawFollow(null); } else goHome();
});
$('layoutNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (!b) return;
  layout = b.dataset.layout;
  try { localStorage.setItem('harness-run-layout', layout); } catch { /* the choice just isn't remembered */ }
  applyView();
  setTimeout(() => runTerminal?.refit(), 0);
});
$('livePanel').addEventListener('click', (e) => {
  const a = e.target.closest('[data-run]');
  if (!a) return;
  e.preventDefault();
  const r = runs.find((x) => x.id === a.dataset.run);
  selected = r.id; agentSel = r.agent || null; inAgent = true; location.hash = r.id; openDetails = new Set();
  applyView(); applyMode(); renderAgents(); renderList(); refresh();
});
function openSettings() { inSettings = true; applyView(); loadGithub(); }
$('agentsGear').addEventListener('click', () => { history.pushState(null, '', '#settings'); openSettings(); });
$('settingsLink').addEventListener('click', () => { history.pushState(null, '', '#settings'); openSettings(); });
window.addEventListener('popstate', () => {
  if (location.hash === '#settings') return openSettings();
  if (inSettings) { inSettings = false; if (!location.hash) return goHome(); applyView(); return; }
  if (!location.hash && inAgent) goHome();
});
$('agentInfo').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-aact]')?.dataset.aact;
  const a = agentOf(agentSel);
  if (act === 'newrun') return openRunDialog();
  if (!act || !a) return;
  if (act === 'edit') return openAgentDialog(a);
  if (act === 'delete') {
    if (!await ui.confirm(`Delete the agent “${a.name}”? Its tasks stay in the list as ordinary runs, and their branches stay in your repo.`)) return;
    try { await sendAgent('DELETE', `/${a.id}`); goHome(); refresh(); } catch (err) { ui.toast(err.message, { kind: 'error' }); }
  }
});

let editingAgent = null;
// Repos beside the default (the Repo field): the whole list is [Repo field, ...agentExtras], and the chips reorder it.
let agentExtras = [];
const agentRepoList = () => Repos.fromSpecs([$('agentRepo').value, ...agentExtras]);
// A chat project's repos (GitHub only on a shared server, which cannot read folders on your computer)
const projectRepoEntries = (link) => Repos.list(chatProjects().find((p) => p.id === link.id)).filter((e) => !hosted || Repos.isGithub(e));
function drawAgentRepos() {
  const all = agentRepoList();
  $('agentMoreChips').innerHTML = all.length > 1 ? Repos.chipsHtml(all, { controls: true, esc }) : '';
  const link = chatProjects().find((p) => p.id === $('agentProject').value);
  const inherited = link ? projectRepoEntries(link) : [];
  const note = $('agentInherit');
  note.hidden = !inherited.length;
  note.innerHTML = inherited.length ? `The project “${esc(link.name)}” has ${inherited.length} repo${inherited.length === 1 ? '' : 's'} (${esc(inherited.map(Repos.labelOf).join(', '))}). ${$('agentRepo').value.trim() || agentExtras.length ? '<button type="button" id="agentUseProject">Use the project’s repos</button>' : 'Leave the Repo empty to use them.'}` : '';
}
function setAgentRepos(entries) {
  const specs = Repos.toSpecs(entries);
  $('agentRepo').value = specs[0] || '';
  agentExtras = specs.slice(1);
  drawAgentRepos();
}

async function initAgentDialog() {
  Repos.bind($('agentMoreChips'), agentRepoList, setAgentRepos);
  const addExtra = () => {
    const v = $('agentMoreInput').value.trim();
    if (!v) return;
    if (!$('agentRepo').value.trim()) $('agentRepo').value = v; else if (![$('agentRepo').value.trim(), ...agentExtras].includes(v)) agentExtras.push(v);
    $('agentMoreInput').value = '';
    drawAgentRepos();
  };
  $('agentMoreAdd').addEventListener('click', addExtra);
  $('agentMoreInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } });
  $('agentRepo').addEventListener('input', drawAgentRepos);
  $('agentProject').addEventListener('change', drawAgentRepos);
  $('agentInherit').addEventListener('click', (e) => {
    if (!e.target.closest('#agentUseProject')) return;
    const link = chatProjects().find((p) => p.id === $('agentProject').value);
    if (link) setAgentRepos(projectRepoEntries(link));
  });
  const f = $('agentForm');
  $('iconShuffle').addEventListener('click', () => { f.elements.iconImage.value = ''; f.elements.iconText.value = ''; setIconSeed(AgentIcon.randomSeed()); });
  $('iconReset').addEventListener('click', () => { f.elements.iconImage.value = ''; f.elements.iconText.value = ''; setIconSeed(''); });
  $('iconText').addEventListener('input', () => { if ($('iconText').value) f.elements.iconImage.value = ''; setIconSeed(f.elements.iconSeed.value); });
  $('iconUpload').addEventListener('click', () => $('iconFile').click());
  $('iconFile').addEventListener('change', async () => {
    const file = $('iconFile').files[0];
    $('iconFile').value = '';
    if (!file) return;
    try {
      f.elements.iconImage.value = await shrinkImage(file);
      f.elements.iconText.value = '';
      setIconSeed(f.elements.iconSeed.value);
    } catch (err) { $('agentMsg').textContent = err.message; }
  });
  $('agentClose').addEventListener('click', () => $('agentDialog').close());
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    const link = chatProjects().find((p) => p.id === body.project);
    body.project = link ? { id: link.id, name: link.name } : (body.project && editingAgent?.project?.id === body.project ? editingAgent.project : null);
    for (const k of ['maxSteps', 'maxMinutes', 'maxCost', 'maxTier', 'iconSeed', 'iconImage', 'iconText']) if (body[k] === '') body[k] = null;
    // The repo field is the default repo; the others are listed below it. With none of its own, the agent takes its project's.
    if (!body.repo.trim() && !agentExtras.length && link) {
      const inherited = Repos.toSpecs(projectRepoEntries(link));
      body.repo = inherited[0] || '';
      agentExtras = inherited.slice(1);
    }
    if (!body.repo.trim()) { $('agentMsg').textContent = 'Give the agent a repo, or link a project that has repos.'; return; }
    body.moreRepos = agentExtras.filter((r) => r !== body.repo.trim());
    if (body.model) body.profile = '';
    body.escalate = f.elements.escalate.checked;
    body.autoContinue = f.elements.autoContinue.checked;
    body.autoContinueMax = body.autoContinueMax === '' ? null : body.autoContinueMax;
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

// the icon in the agent dialog: the seed in the form wins, else the agent's id; a new agent starts with a rolled one
function setIconSeed(seed) {
  const f = $('agentForm');
  f.elements.iconSeed.value = seed;
  const custom = { iconImage: f.elements.iconImage.value, iconText: f.elements.iconText.value };
  $('iconPreview').innerHTML = AgentIcon.orb({ id: seed || editingAgent?.id || 'new', ...custom });
  $('iconReset').hidden = !(seed || custom.iconImage || custom.iconText) || !editingAgent;
}
// a picked picture, cropped square and scaled to 128 px so it stays a few KB
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
      for (const q of [0.85, 0.7, 0.5]) {
        const out = c.toDataURL('image/jpeg', q);
        if (out.length <= 24000) return resolve(out);
      }
      reject(new Error('that picture is too detailed to shrink; try another'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file is not a picture the browser can read')); };
    img.src = url;
  });
}
function openAgentDialog(agent) {
  editingAgent = agent;
  const f = $('agentForm');
  $('agentDialogTitle').textContent = agent ? `Edit ${agent.name}` : 'New agent';
  $('agentMsg').textContent = '';
  const projects = chatProjects();
  const linked = agent?.project && !projects.some((p) => p.id === agent.project.id) ? [{ id: agent.project.id, name: `${agent.project.name || 'A project'} (not in this browser)` }] : [];
  $('agentProject').innerHTML = '<option value="">None</option>' + [...projects, ...linked].map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  agentExtras = (agent?.moreRepos || []).slice();
  $('agentMoreInput').value = '';
  const v = agent || { name: '', repo: recentRepos()[0] || '', instructions: '', workflow: 'general', profile: '', effort: '', maxSteps: '', maxMinutes: '', maxCost: '', project: null };
  f.elements.name.value = v.name;
  f.elements.repo.value = v.repo;
  f.elements.instructions.value = v.instructions || '';
  f.elements.workflow.value = v.workflow || 'general';
  f.elements.profile.value = v.profile || '';
  f.elements.model.value = v.model || '';
  f.elements.effort.value = v.effort || '';
  f.elements.sandbox.value = v.sandbox || '';
  f.elements.maxSteps.value = v.maxSteps ?? '';
  f.elements.maxMinutes.value = v.maxMinutes ?? '';
  f.elements.maxCost.value = v.maxCost ?? '';
  f.elements.maxTier.value = v.maxTier || '';
  f.elements.escalate.checked = v.escalate !== false;
  f.elements.autoContinue.checked = !!v.autoContinue;
  f.elements.autoContinueMax.value = v.autoContinueMax ?? '';
  f.elements.project.value = v.project?.id || '';
  f.elements.iconImage.value = agent?.iconImage || '';
  f.elements.iconText.value = agent?.iconText || '';
  setIconSeed(agent ? agent.iconSeed || '' : AgentIcon.randomSeed());
  drawAgentRepos();
  $('agentDialog').showModal();
  f.elements.name.focus();
}
