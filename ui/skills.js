// Skills page: the list of skills the chat page uses (harness-skills in this browser), with a
// place to write, edit, delete and import them. Chat keeps the same list, so it is read and saved
// the same way: each save bumps the sync stamp and is pushed to the server when it has a database.
(() => {
  const $ = (s) => document.querySelector(s);
  const form = $('#editor');
  const f = form.elements;
  const SKILLS = 'harness-skills', PROJECTS = 'harness-projects';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const toast = (t, bad) => ui.toast(t, bad ? { kind: 'error' } : {});
  const el = (tagName, props = {}, ...kids) => { const n = Object.assign(document.createElement(tagName), props); n.append(...kids); return n; };

  let skills = read(SKILLS, []);
  let current = null;   // the skill open in the editor
  let syncOn = false;

  function read(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  }
  // Same as chat: local copy first, then the server when it keeps a database (chat pulls the newer one)
  function save(key, value) {
    const updated = Date.now();
    try { localStorage.setItem(key, JSON.stringify(value)); localStorage.setItem(`harness-sync-ts:${key}`, String(updated)); } catch (e) { toast(`Could not save: ${e.message}`, true); }
    if (syncOn) fetch(`api/sync/data/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, updated }) }).catch(() => {});
  }
  const saveSkills = () => save(SKILLS, skills);
  async function checkSync() {
    try { const r = await fetch('api/sync', { credentials: 'same-origin' }); syncOn = r.ok && !!(await r.json()).db; } catch { syncOn = false; }
  }

  const cleanName = (s) => s.trim().replace(/\s+/g, '-');
  const projectsUsing = (id) => read(PROJECTS, []).filter((p) => (p.skills || []).includes(id)).length;

  function drawList() {
    const q = $('#search').value.trim().toLowerCase();
    const shown = skills.filter((k) => !q || `${k.name} ${k.description || ''}`.toLowerCase().includes(q));
    $('#list').replaceChildren(...shown.map((k) => {
      const b = el('button', { type: 'button', className: k === current ? 'on' : '' }, el('b', { textContent: k.name || '(no name)' }), el('small', { textContent: k.description || (k.body || '').slice(0, 80) || 'No instructions yet' }));
      b.dataset.id = k.id;
      return b;
    }));
    if (!shown.length) $('#list').append(el('p', { className: 'muted fine', textContent: skills.length ? 'No skill matches.' : 'No skills yet.' }));
    $('#empty').hidden = skills.length > 0;
  }

  function open(k) {
    current = k || null;
    form.hidden = !current;
    if (current) {
      f.name.value = current.name || '';
      f.description.value = current.description || '';
      f.body.value = current.body || '';
      const n = projectsUsing(current.id);
      $('#usedIn').textContent = n ? `On in ${n} project${n === 1 ? '' : 's'}; chats can switch it on too.` : 'Off everywhere for now.';
    }
    drawList();
  }

  // Edits save as you type, as chat's skills dialog does
  for (const key of ['name', 'description', 'body']) {
    f[key].addEventListener('input', () => {
      if (!current) return;
      current[key] = key === 'name' ? cleanName(f.name.value) : f[key].value;
      saveSkills();
      if (key === 'name') drawList();
    });
  }

  $('#new').addEventListener('click', () => {
    const k = { id: uid(), name: `skill-${skills.length + 1}`, description: '', body: '' };
    skills.push(k);
    saveSkills();
    open(k);
    f.name.select();
  });

  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) open(skills.find((k) => k.id === b.dataset.id));
  });
  $('#search').addEventListener('input', drawList);

  $('#delete').addEventListener('click', async () => {
    if (!current || !await ui.confirm(`Delete the skill “${current.name}”? It is also switched off in every project.`, { danger: true })) return;
    const id = current.id;
    skills = skills.filter((k) => k.id !== id);
    saveSkills();
    const projects = read(PROJECTS, []);
    let changed = false;
    for (const p of projects) if (p.skills?.includes(id)) { p.skills = p.skills.filter((x) => x !== id); changed = true; }
    if (changed) save(PROJECTS, projects);
    open(skills[0] || null);
  });

  // Claude Code's own skills (.claude/skills here and in the home folder); only on the machine running the harness
  const importBox = $('#importBox');
  let kit = null;
  async function drawImport() {
    const ul = $('#importList');
    if (!kit) {
      ul.innerHTML = '<li class="muted fine">Looking…</li>';
      try {
        const r = await fetch('api/claude-kit', { credentials: 'same-origin' });
        kit = r.ok ? (await r.json()).items : [];
        if (!r.ok) { ul.replaceChildren(el('li', { className: 'muted fine', textContent: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` })); return; }
      } catch { kit = []; }
    }
    const have = new Set(skills.map((k) => k.name.toLowerCase()));
    const items = kit.filter((i) => i.kind === 'skill');
    ul.replaceChildren(...items.map((i, n) => {
      const added = have.has(i.name.toLowerCase());
      const add = el('button', { type: 'button', className: 'mini', textContent: added ? 'Added' : 'Add', disabled: added });
      add.dataset.import = String(n);
      return el('li', {}, el('b', { textContent: i.name }), ' ', el('span', { className: 'muted', textContent: `(${i.source})` }), i.description ? el('small', { textContent: i.description }) : '', add);
    }));
    if (!items.length) ul.replaceChildren(el('li', { className: 'muted fine', textContent: 'Nothing found in .claude/skills (here or in your home folder).' }));
  }
  importBox.addEventListener('toggle', () => { if (importBox.open) drawImport(); });
  $('#importList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-import]');
    if (!b) return;
    const i = kit.filter((x) => x.kind === 'skill')[Number(b.dataset.import)];
    const k = { id: uid(), name: i.name, description: i.description || '', body: i.body || '' };
    skills.push(k);
    saveSkills();
    drawImport();
    open(k);
  });

  // Opens on the first skill
  (async () => {
    await checkSync();
    open(skills[0] || null);
  })();
})();
