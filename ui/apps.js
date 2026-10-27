// Apps section of the Agents page: register an app (repo, dev server, tests, the paths an
// agent may edit) and ask it for a change. A change is an ordinary run, listed under Runs,
// with its preview and diff there.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = async (method, path, body) => {
    const res = await fetch(`api/apps${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  let apps = [];

  function render() {
    $('appList').innerHTML = apps.length ? apps.map((a) => `<div class="app-row" data-id="${esc(a.id)}">
      <div><strong>${esc(a.name)}</strong> <span class="muted">${esc(a.repo)}</span><br><span class="muted fine">Edits only: ${esc(a.editablePaths.join(', '))}${a.testCommand ? ` · tests: ${esc(a.testCommand)}` : ''}</span></div>
      <div class="actions"><button type="button" class="primary" data-act="change">Ask for a change</button><button type="button" data-act="edit">Edit</button><button type="button" data-act="remove">Remove</button></div>
    </div>`).join('') : '<p class="muted">No apps yet. Register one to ask it for changes.</p>';
  }
  async function load() {
    try { apps = (await call('GET', '')).apps; render(); } catch (err) { $('appList').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  function openForm(app) {
    const f = $('appForm');
    f.reset();
    f.dataset.id = app?.id || '';
    $('appFormTitle').textContent = app ? `Edit ${app.name}` : 'Register an app';
    for (const [k, v] of Object.entries(app || {})) if (f.elements[k]) f.elements[k].value = Array.isArray(v) ? v.join('\n') : (v ?? '');
    $('appMsg').textContent = '';
    $('appDialog').showModal();
  }

  $('appAdd').addEventListener('click', () => openForm(null));
  $('appClose').addEventListener('click', () => $('appDialog').close());
  $('appForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    try {
      if (f.dataset.id) await call('PATCH', `/${f.dataset.id}`, body); else await call('POST', '', body);
      $('appDialog').close();
      load();
    } catch (err) { $('appMsg').textContent = err.message; }
  });

  $('appList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    const app = apps.find((a) => a.id === btn?.closest('.app-row')?.dataset.id);
    if (!app) return;
    if (btn.dataset.act === 'edit') return openForm(app);
    if (btn.dataset.act === 'remove') {
      if (!confirm(`Remove ${app.name}? Its past change runs stay.`)) return;
      try { await call('DELETE', `/${app.id}`); load(); } catch (err) { alert(err.message); }
      return;
    }
    $('changeTitle').textContent = `Ask ${app.name} for a change`;
    $('changeForm').dataset.id = app.id;
    $('changeMsg').textContent = '';
    $('changeDialog').showModal();
  });
  $('changeClose').addEventListener('click', () => $('changeDialog').close());
  $('changeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const run = await call('POST', `/${f.dataset.id}/changes`, { request: f.elements.request.value });
      $('changeDialog').close();
      f.reset();
      location.hash = run.id;
      location.reload();
    } catch (err) { $('changeMsg').textContent = err.message; }
  });

  load();
})();
