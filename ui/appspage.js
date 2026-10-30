// Apps page: the apps the harness can change, and a builder that starts a new one from a template.
// The runner does the work (/ui/api/apps); this page lists, asks and sends the person on to Agents to watch.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (method, path, body) => {
    const res = await fetch(`/ui/api/apps${path}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  let apps = [];
  let templates = [];

  function paintApps() {
    $('#appList').innerHTML = apps.length ? apps.map((a) => `<div class="app-row" data-id="${esc(a.id)}">
      <div class="app-info"><strong>${esc(a.name)}</strong><span class="muted fine">${esc(a.repo)}</span><span class="muted fine">Edits only: ${esc(a.editablePaths.join(', '))}${a.testCommand ? ` · tests: ${esc(a.testCommand)}` : ''}</span></div>
      <div class="actions"><button type="button" class="primary" data-act="change">Ask for a change</button></div>
    </div>`).join('') : '<p class="muted">No apps yet. Start one from a template below.</p>';
  }

  function paintTemplates() {
    $('#tpls').innerHTML = templates.length ? templates.map((t, i) => `<label class="tpl">
      <input type="radio" name="template" value="${esc(t.id)}"${i === 0 ? ' checked' : ''}>
      <b>${esc(t.name)}</b><span>${esc(t.description)}</span><small class="muted">${esc((t.stack || []).join(' · '))}</small>
    </label>`).join('') : '<p class="muted">No templates yet. Add one under templates/.</p>';
    paintQuestions();
  }

  const current = () => templates.find((t) => t.id === document.querySelector('input[name=template]:checked')?.value);

  function paintQuestions() {
    const t = current();
    $('#questions').innerHTML = (t?.questions || []).map((q) => `<label class="field"><span>${esc(q.label)}${q.required ? '' : ' <small>(optional)</small>'}</span>
      <input name="q_${esc(q.key)}"${q.required ? ' required' : ''} placeholder="${esc(q.placeholder || '')}"></label>`).join('');
  }

  async function loadApps() {
    try { apps = (await api('GET', '')).apps; paintApps(); } catch (err) { $('#appList').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  async function loadTemplates() {
    try { templates = (await api('GET', '/templates')).templates; paintTemplates(); } catch (err) { $('#tpls').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  async function loadRoots() {
    try {
      const r = await (await fetch('/ui/api/runs/repos', { credentials: 'same-origin' })).json();
      $('#roots').innerHTML = (r.roots || []).map((p) => `<option value="${esc(p)}">`).join('');
    } catch { /* the server picks the folder */ }
  }

  $('#tpls').addEventListener('change', paintQuestions);

  $('#appList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act=change]');
    const app = apps.find((a) => a.id === btn?.closest('.app-row')?.dataset.id);
    if (!app) return;
    const request = await ui.prompt(`What should ${app.name} do differently?`, { ok: 'Start change', placeholder: 'Add a dark mode toggle' });
    if (!request) return;
    try {
      const run = await api('POST', `/${app.id}/changes`, { request });
      location.href = `agents.html#${run.id}`;
    } catch (err) { ui.toast(err.message, { kind: 'error' }); }
  });

  $('#newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const t = current();
    if (!t) return;
    const answers = Object.fromEntries(t.questions.map((q) => [q.key, f.elements[`q_${q.key}`]?.value || '']));
    const msg = $('#newMsg');
    const btn = $('#create');
    btn.disabled = true;
    msg.textContent = 'Making the folder…';
    try {
      const { app, run } = await api('POST', '/new', {
        template: t.id, name: f.elements.name.value, description: f.elements.description.value,
        parent: f.elements.parent.value.trim() || undefined, answers, build: f.elements.build.checked,
      });
      if (run) { location.href = `agents.html#${run.id}`; return; }
      f.reset();
      paintQuestions();
      msg.textContent = `${app.name} is ready in ${app.repo}.`;
      loadApps();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  loadApps();
  loadTemplates();
  loadRoots();
})();
