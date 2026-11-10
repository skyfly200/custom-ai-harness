// One app: its settings, git history, chat (ask for changes in words, by typing or speaking), and its runs.
// The runner does the work (/ui/api/apps, /ui/api/runs); a change is an ordinary run on Agents.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (method, path, body) => {
    const res = await fetch(`/ui/api/${path}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(method === 'GET' || method === 'DELETE' && !body ? {} : { body: JSON.stringify(body ?? {}) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  const id = new URLSearchParams(location.search).get('id') || '';
  let app = null;
  let hosting = { targets: [], databases: [] };
  let agents = new Map();
  let runs = [];
  let timer = null;

  const label = (list, key) => list.find((o) => o.id === key)?.label || 'none';
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const requestOf = (run) => String(run.goal || '').replace(/^Change the app "[^"]*": /, '').split('\n')[0].trim();

  function paintHead() {
    $('#appName').textContent = app.name;
    const agent = app.agent && agents.get(app.agent);
    $('#appSub').textContent = [app.githubRepo ? `GitHub: ${app.githubRepo}` : 'A folder on this computer', agent ? `Agent: ${agent.name}` : 'No agent'].join(' · ');
    document.title = `Bright Chat · ${app.name}`;
  }

  function paintFacts() {
    const rows = [
      ['Folder', app.repo],
      ['GitHub repo', app.githubRepo || 'none'],
      ['Base branch', app.baseBranch || 'the repo default'],
      ['Agent', app.agent && agents.get(app.agent) ? agents.get(app.agent).name : 'none'],
      ['Hosting', label(hosting.targets, app.deployTarget)],
      ['Database', label(hosting.databases, app.database)],
      ['When a change is merged', app.deploy === 'hook' ? `Call ${app.deployHook || 'a deploy hook'}` : 'The host deploys from the repo'],
      ['Changes may edit', (app.editablePaths || []).join(', ') || 'nothing yet'],
      ['Install', app.installCommand || 'none'],
      ['Tests', app.testCommand || 'none yet'],
      ['Dev server', app.devCommand || 'none'],
      ['Preview port', app.previewPort || 'none'],
    ];
    $('#facts').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join('');
    $('#editLink').href = `apps.html#edit=${encodeURIComponent(app.id)}`;
    $('#snippet').textContent = `<script src="${location.origin}/ui/agent-widget.js" data-app="${app.id}" defer></script>`;
  }

  async function paintHistory() {
    const out = $('#commits');
    try {
      const h = await api('GET', `apps/${encodeURIComponent(id)}/history?limit=40`);
      $('#branchLine').textContent = h.branch ? `On branch ${h.branch}. Newest first.` : 'Not a git folder yet.';
      out.innerHTML = h.commits.length
        ? h.commits.map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)} <span class="muted fine">${esc(c.author)} · ${esc(when(c.date))}</span></li>`).join('')
        : '<li class="muted">No commits yet.</li>';
    } catch (err) { out.innerHTML = `<li class="muted">${esc(err.message)}</li>`; }
  }

  /** The runs of this app, newest first. A change's request is what the person asked; the status is where it stands. */
  function statusText(run) {
    if (['queued', 'running'].includes(run.status)) return run.stage ? `Working (${run.stage})…` : 'Working…';
    if (run.status === 'waiting') return 'Waiting for your OK on Agents';
    if (run.status === 'done') return run.proposal ? 'Proposed as a pull request' : 'Done: review, preview and ship or undo on Agents';
    if (run.status === 'stopped') return 'Stopped';
    if (run.status === 'incomplete') return 'Ran out of a limit; continue it on Agents';
    return run.error ? `Failed: ${run.error}` : run.status;
  }

  function paintChat() {
    const mine = runs.slice().reverse();
    $('#thread').innerHTML = mine.length
      ? mine.map((r) => `<div class="turn">
          <div class="bubble me">${esc(requestOf(r))}<span class="fine muted">${esc(when(r.created))}</span></div>
          <div class="bubble agent">${esc(statusText(r))} <a href="agents.html#${esc(r.id)}">Open on Agents</a></div>
        </div>`).join('')
      : '<p class="muted">No changes yet. Say what should be different.</p>';
    $('#thread').scrollTop = $('#thread').scrollHeight;
  }

  function paintRuns() {
    $('#runList').innerHTML = runs.length
      ? `<table class="runs"><thead><tr><th>When</th><th>Status</th><th>Request</th><th></th></tr></thead><tbody>${runs.map((r) => `<tr>
          <td class="fine muted">${esc(when(r.created))}</td><td>${esc(r.status)}${r.proposal ? ' <span class="muted fine">(proposal)</span>' : ''}</td>
          <td>${esc(requestOf(r))}</td><td><a href="agents.html#${esc(r.id)}">Open</a></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No runs yet for this app.</p>';
  }

  async function loadRuns() {
    try {
      const { runs: all } = await api('GET', 'runs');
      runs = all.filter((r) => r.app === id);
      paintChat();
      paintRuns();
    } catch (err) { $('#runList').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  async function load() {
    if (!id) { $('#appName').textContent = 'No app chosen'; $('#appSub').innerHTML = '<a href="apps.html">Pick one on the Apps page</a>.'; return; }
    try {
      app = await api('GET', `apps/${encodeURIComponent(id)}`);
    } catch (err) { $('#appName').textContent = 'App not found'; $('#appSub').textContent = err.message; return; }
    try { hosting = await api('GET', 'apps/hosting'); } catch { /* the labels fall back to the ids */ }
    try { for (const a of (await api('GET', 'agents')).agents || []) agents.set(a.id, a); } catch { /* no agents to name */ }
    paintHead();
    paintFacts();
    paintHistory();
    loadRuns();
  }

  // ---- tabs ----
  function show(name) {
    for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    if (name === 'chat' || name === 'runs') loadRuns();
    if (name === 'history') paintHistory();
    clearInterval(timer);
    if (name === 'chat' || name === 'runs') timer = setInterval(loadRuns, 5000);
    history.replaceState(null, '', `#${name}`);
  }
  for (const t of document.querySelectorAll('[data-tab]')) t.addEventListener('click', () => show(t.dataset.tab));
  show(['overview', 'history', 'chat', 'runs'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');

  // ---- actions ----
  $('#askBtn').addEventListener('click', () => { show('chat'); $('#composer textarea').focus(); });

  $('#deleteBtn').addEventListener('click', async () => {
    if (!app) return;
    if (!await ui.confirm(`Delete ${app.name}? Its change runs stay on Agents, and its repo and any agent are not touched.`)) return;
    try {
      await api('DELETE', `apps/${encodeURIComponent(app.id)}`);
      location.href = 'apps.html';
    } catch (err) { ui.toast(err.message, { kind: 'error' }); }
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = e.target.elements.request;
    const text = ta.value.trim();
    if (!text) return;
    const msg = $('#composeMsg');
    msg.textContent = 'Starting…';
    try {
      await api('POST', `apps/${encodeURIComponent(id)}/changes`, { request: text });
      ta.value = '';
      msg.textContent = '';
      loadRuns();
    } catch (err) { msg.textContent = err.message; }
  });

  // ---- speech to text: the Speak button fills the request (the widget on this page has its own) ----
  const mic = $('#mic');
  if (window.HarnessSST?.supported()) {
    mic.hidden = false;
    let stop = null;
    mic.addEventListener('click', () => {
      if (stop) return stop();
      const ta = $('#composer textarea');
      stop = window.HarnessSST.start({
        onText: (t) => { ta.value = window.HarnessSST.append(ta.value, t); },
        onEnd: () => { stop = null; mic.textContent = '🎙 Speak'; },
        onError: (err) => { $('#composeMsg').textContent = `Speech: ${err}`; },
      });
      mic.textContent = '■ Stop';
    });
  }

  load();
})();
