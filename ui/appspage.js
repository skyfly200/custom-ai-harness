// Apps page: the apps the harness can change, and a builder (in a modal) that starts a new one from a template.
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
  let hosting = { targets: [], databases: [] };
  let repos = null; // null until the first look at the GitHub repos

  const label = (list, id) => list.find((o) => o.id === id)?.label || 'none';

  function paintApps() {
    $('#appList').innerHTML = apps.length ? apps.map((a) => `<div class="app-row" data-id="${esc(a.id)}">
      <div class="app-info"><strong>${esc(a.name)}</strong><span class="muted fine">${esc(a.repo)}</span>
        <span class="muted fine">Hosting: ${esc(label(hosting.targets, a.deployTarget))} · Database: ${esc(label(hosting.databases, a.database))}${a.githubRepo ? ` · GitHub: ${esc(a.githubRepo)}` : ''}</span>
        <span class="muted fine">Edits only: ${esc(a.editablePaths.join(', '))}${a.testCommand ? ` · tests: ${esc(a.testCommand)}` : ''}</span></div>
      <div class="actions"><button type="button" class="primary" data-act="change">Ask for a change</button></div>
    </div>`).join('') : '<p class="muted">No apps yet. Start one with New app.</p>';
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

  function paintHosting() {
    const f = $('#newForm');
    const keep = { deploy: f.elements.deployTarget.value || 'none', db: f.elements.database.value || 'none' };
    $('#deployTarget').innerHTML = hosting.targets.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    $('#database').innerHTML = hosting.databases.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    f.elements.deployTarget.value = keep.deploy;
    f.elements.database.value = keep.db;
    paintChoices();
  }

  /** What to connect for a host and database: the steps, the secrets to add, as HTML. `github` says the repo is on GitHub. */
  function connectHtml(target, db, github) {
    const steps = [target, db].filter((o) => o.account).map((o) => `<li><b>${esc(o.label)}:</b> ${esc(o.account)}</li>`);
    const secrets = [...new Set([...target.secrets, ...db.secrets])];
    const secretsText = secrets.length
      ? `<p class="fine">${github ? 'Add these as secrets on the GitHub repo (Settings > Secrets and variables > Actions). The harness never sees their values:' : 'Once the app has a GitHub repo, add these as secrets on it (Settings > Secrets and variables > Actions):'}</p>
         <p class="fine">${secrets.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>`
      : '';
    return steps.length || secrets.length
      ? `<strong class="fine">What you need to connect</strong><ol>${steps.join('')}</ol>${secretsText}<p class="fine muted">The builder writes DEPLOY.md with these steps in the app's repo.</p>`
      : '<p class="fine muted">Nothing to connect: the app runs on this computer, and tests run only when you push it to GitHub.</p>';
  }

  /** The help under each choice, and the list of what to connect for the chosen host and database. */
  function paintChoices() {
    const f = $('#newForm');
    const target = hosting.targets.find((o) => o.id === f.elements.deployTarget.value) || hosting.targets[0];
    const db = hosting.databases.find((o) => o.id === f.elements.database.value) || hosting.databases[0];
    if (!target || !db) return;
    $('#targetHelp').textContent = target.help;
    $('#databaseHelp').textContent = db.help;
    $('#connectBox').innerHTML = connectHtml(target, db, f.elements.repoMode.value !== 'local');
  }

  /** Repo picker: the GitHub repos this connection reaches, loaded the first time they are needed. */
  async function loadRepos(sel = $('#newForm').elements.existingRepo, note = $('#ghNote')) {
    if (repos) return paintRepos(sel);
    try {
      const r = await fetch('/ui/api/github/repos', { credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      repos = data.repos || [];
      note.textContent = repos.length ? '' : 'No repos are reachable with your GitHub connection.';
    } catch (err) {
      repos = [];
      note.innerHTML = `${esc(err.message)}. Connect GitHub on the <a href="settings.html">Settings</a> page to create or pick a repo.`;
    }
    paintRepos(sel);
  }
  function paintRepos(sel) {
    const picked = sel.value;
    sel.innerHTML = repos.length
      ? `<option value="">Choose a repo</option>${repos.map((r) => `<option value="${esc(r.full)}">${esc(r.full)}${r.private ? ' (private)' : ''}</option>`).join('')}`
      : '<option value="">No repos to pick</option>';
    if (picked) sel.value = picked;
  }

  /** Show or hide the repo field each choice needs. */
  function paintRepoMode() {
    const mode = document.querySelector('input[name=repoMode]:checked')?.value || 'local';
    for (const el of document.querySelectorAll('.field[data-for]')) el.hidden = el.dataset.for !== mode;
    if (mode === 'existing') loadRepos();
    else $('#ghNote').textContent = mode === 'create' ? 'Your GitHub connection makes the repo under your account, private unless you change it on GitHub.' : '';
    paintChoices();
  }

  async function loadApps() {
    try { apps = (await api('GET', '')).apps; paintApps(); } catch (err) { $('#appList').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  async function loadTemplates() {
    try { templates = (await api('GET', '/templates')).templates; paintTemplates(); } catch (err) { $('#tpls').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  }

  async function loadHosting() {
    try { hosting = await api('GET', '/hosting'); paintHosting(); } catch { /* the form still works with the defaults */ }
  }

  async function loadRoots() {
    try {
      const r = await (await fetch('/ui/api/runs/repos', { credentials: 'same-origin' })).json();
      $('#roots').innerHTML = (r.roots || []).map((p) => `<option value="${esc(p)}">`).join('');
    } catch { /* the server picks the folder */ }
  }

  $('#tpls').addEventListener('change', paintQuestions);
  $('#newForm').addEventListener('change', (e) => {
    if (e.target.name === 'repoMode') paintRepoMode();
    else if (e.target.name === 'deployTarget' || e.target.name === 'database') paintChoices();
  });

  $('#newApp').addEventListener('click', () => {
    const f = $('#newForm');
    f.reset();
    $('#newMsg').textContent = '';
    paintQuestions();
    paintRepoMode();
    $('#newDialog').showModal();
  });
  $('#newClose').addEventListener('click', () => $('#newDialog').close());

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

  /** What the form sends for the repo: none (local), a new repo name, or an existing owner/name. */
  function repoChoice(f) {
    const mode = f.elements.repoMode.value;
    if (mode === 'create') return { mode, repo: f.elements.newRepo.value.trim() || undefined };
    if (mode === 'existing') {
      const repo = f.elements.existingRepo.value;
      if (!repo) throw new Error('choose the existing repo, or pick another option');
      return { mode, repo };
    }
    return { mode: 'local' };
  }

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
        github: repoChoice(f), deployTarget: f.elements.deployTarget.value, database: f.elements.database.value,
      });
      if (run) { location.href = `agents.html#${run.id}`; return; }
      $('#newDialog').close();
      ui.toast(`${app.name} is ready${app.githubRepo ? `, and its GitHub repo is ${app.githubRepo}` : ` in ${app.repo}`}.`);
      loadApps();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Import an existing app: look first (read only), then fill the form and register it ----
  let looked = null; // the detection for the folder or repo the person looked at

  const importForm = () => $('#importForm');
  const importSource = () => importForm().elements.source.value;

  function paintImportSrc() {
    const src = importSource();
    for (const el of importForm().querySelectorAll('[data-src]')) el.hidden = el.dataset.src !== src;
    if (src === 'github') loadRepos(importForm().elements.githubRepo, $('#importNote'));
    else $('#importNote').textContent = '';
    hideImportRest();
  }

  function hideImportRest() {
    looked = null;
    $('#importRest').hidden = true;
    $('#importMsg').textContent = '';
  }

  /** The select options for host and database, with the detection's pick selected. */
  function paintImportChoices() {
    const f = importForm();
    const target = hosting.targets.find((o) => o.id === f.elements.deployTarget.value) || hosting.targets[0];
    const db = hosting.databases.find((o) => o.id === f.elements.database.value) || hosting.databases[0];
    if (!target || !db) return;
    $('#importTargetHelp').textContent = target.help;
    $('#importDatabaseHelp').textContent = db.help;
    $('#importConnect').innerHTML = connectHtml(target, db, importSource() === 'github' || Boolean(looked?.githubRepo));
  }

  function fillImport(d) {
    const f = importForm();
    f.elements.deployTarget.innerHTML = hosting.targets.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    f.elements.database.innerHTML = hosting.databases.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    f.elements.deployTarget.value = d.deployTarget;
    f.elements.database.value = d.database;
    f.elements.name.value = d.suggestedName || '';
    f.elements.name.placeholder = d.suggestedName || 'Note board';
    f.elements.editablePaths.value = d.editablePaths.join('\n');
    f.elements.installCommand.value = d.installCommand || '';
    f.elements.testCommand.value = d.testCommand || '';
    f.elements.devCommand.value = d.devCommand || '';
    $('#importFound').textContent = d.stack.length ? `Looks like ${d.stack.join(' · ')}.` : 'No known stack found. You can still register it and fill in the details.';
    $('#importNotes').innerHTML = d.notes.map((n) => `<li>${esc(n)}</li>`).join('');
    const present = [d.hasCi && 'a CI workflow', d.hasDeploy && 'a deploy workflow', d.hasDeployDoc && 'DEPLOY.md'].filter(Boolean);
    if (present.length) $('#importNotes').insertAdjacentHTML('beforeend', `<li>Already has ${esc(present.join(', '))}; those files are kept.</li>`);
    $('#importRest').hidden = false;
    paintImportChoices();
  }

  $('#importApp').addEventListener('click', () => {
    importForm().reset();
    hideImportRest();
    paintImportSrc();
    $('#importDialog').showModal();
  });
  $('#importClose').addEventListener('click', () => $('#importDialog').close());

  importForm().addEventListener('change', (e) => {
    if (e.target.name === 'source') paintImportSrc();
    else if (e.target.name === 'deployTarget' || e.target.name === 'database') paintImportChoices();
  });

  $('#importLook').addEventListener('click', async () => {
    const f = importForm();
    const body = importSource() === 'github'
      ? { source: 'github', repo: f.elements.githubRepo.value }
      : { source: 'local', folder: f.elements.folder.value.trim() };
    if (body.source === 'github' && !body.repo) return ui.toast('Choose a repo first.', { kind: 'error' });
    if (body.source === 'local' && !body.folder) return ui.toast('Type the folder first.', { kind: 'error' });
    const btn = $('#importLook');
    btn.disabled = true;
    $('#importMsg').textContent = 'Looking…';
    try {
      looked = await api('POST', '/import/detect', body);
      fillImport(looked);
      $('#importMsg').textContent = '';
    } catch (err) {
      hideImportRest();
      ui.toast(err.message, { kind: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  importForm().addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!looked) return;
    const f = importForm();
    const msg = $('#importMsg');
    const btn = $('#importGo');
    const body = {
      source: looked.source,
      ...(looked.source === 'github' ? { repo: looked.githubRepo } : { folder: looked.folder }),
      name: f.elements.name.value.trim() || undefined,
      deployTarget: f.elements.deployTarget.value,
      database: f.elements.database.value,
      editablePaths: f.elements.editablePaths.value.split('\n').map((s) => s.trim()).filter(Boolean),
      installCommand: f.elements.installCommand.value.trim(),
      testCommand: f.elements.testCommand.value.trim(),
      devCommand: f.elements.devCommand.value.trim(),
      previewPort: looked.previewPort,
      addFiles: f.elements.addFiles.checked,
    };
    btn.disabled = true;
    msg.textContent = 'Importing…';
    try {
      const { app, added } = await api('POST', '/import', body);
      $('#importDialog').close();
      ui.toast(`${app.name} is imported${added.length ? `, and ${added.length} file${added.length === 1 ? '' : 's'} were added for you to review` : ''}.`);
      loadApps();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  loadApps();
  loadTemplates();
  loadHosting();
  loadRoots();
})();
