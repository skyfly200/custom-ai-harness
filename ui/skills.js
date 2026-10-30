// Skills page: a list on the left, the editor on the right. Skills live in this browser's localStorage, the same
// list the chat page reads; with a database on the server they are also saved there (api/sync). Agents keep a
// copy of each skill they use, so saving a skill sends the copy again to every agent that has it (or drops it).
(() => {
  const $ = (s) => document.querySelector(s);
  const M = window.SkillsModel;
  const form = $('#editor');
  const f = form.elements; // not form.name: that is the form's own name
  const KEYS = { skills: 'harness-skills', projects: 'harness-projects' };

  let skills = [];
  let projects = [];
  let agents = null;   // null: the agents could not be loaded (no runner, or not signed in)
  let dbOn = false;    // with a database, what is saved here is also kept on the server
  let selected = null; // id of the skill in the editor
  let draft = null;    // a new skill not saved yet: it joins the list on its first save
  let query = '';
  let kitItems = null; // .claude skills, once fetched

  const toast = (t, bad) => ui.toast(t, bad ? { kind: 'error' } : {});
  const el = (tagName, props = {}, ...kids) => { const n = Object.assign(document.createElement(tagName), props); n.append(...kids); return n; };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const current = () => skills.find((k) => k.id === selected) || (draft && draft.id === selected ? draft : null);

  // Local copy first, then the server when there is one (the same call the chat page makes after a save).
  async function store(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    if (!dbOn) return;
    const updated = Date.now();
    try { localStorage.setItem(`harness-sync-ts:${key}`, String(updated)); } catch {}
    const r = await fetch(`api/sync/data/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, updated }) });
    if (!r.ok) throw new Error(`Saved on this device, but not to your account (HTTP ${r.status}).`);
  }

  async function load() {
    await window.OwnerScope?.ready; // another person's copy in this browser is cleared first
    if (window.OwnerScope?.reloading) return;
    try { dbOn = !!(await fetch('api/sync', { headers: { accept: 'application/json' } }).then((r) => r.json())).db; } catch { dbOn = false; }
    try {
      const r = await fetch('api/agents', { headers: { accept: 'application/json' } });
      agents = r.ok ? (await r.json()).agents || [] : null;
    } catch { agents = null; }
    skills = read(KEYS.skills, []);
    projects = read(KEYS.projects, []);
    selected = skills[0]?.id ?? null;
    paintAll();
  }

  // ---- the list -------------------------------------------------------------
  function paintList() {
    const q = query.trim().toLowerCase();
    const shown = skills.filter((k) => !q || `${k.name} ${k.description || ''}`.toLowerCase().includes(q));
    $('#list').replaceChildren(...shown.map((k) => el('div', { className: `item${k.id === selected ? ' on' : ''}${k.disabled ? ' off' : ''}` },
      el('button', { type: 'button', className: 'pick', onclick: () => choose(k.id) },
        el('b', {}, k.name || '(no name)', k.disabled ? el('span', { className: 'tag', textContent: 'Off' }) : ''),
        el('small', { textContent: k.description || k.body.replace(/\s+/g, ' ').slice(0, 120) })),
      el('button', { type: 'button', className: 'quiet switch-btn', textContent: k.disabled ? 'Turn on' : 'Turn off',
        title: k.disabled ? 'Let chats and agents use it again' : 'Chats and agents stop using it until it is turned on', onclick: () => toggle(k.id) }))));
    if (!shown.length && skills.length) $('#list').replaceChildren(el('p', { className: 'muted small', textContent: 'No skill matches.' }));
  }

  function choose(id) {
    if (draft && draft.id !== id) draft = null; // an unsaved new skill is dropped when you pick another
    selected = id;
    paintAll();
  }

  // ---- the editor -----------------------------------------------------------
  function paintEditor() {
    const k = current();
    form.hidden = !k;
    $('#empty').hidden = !!k || skills.length > 0;
    if (!k) return;
    f.name.value = k.name || '';
    f.description.value = k.description || '';
    f.enabled.checked = !k.disabled;
    f.body.value = k.body || '';
    $('#status').textContent = '';
    $('#delete').hidden = !skills.some((x) => x.id === k.id);
    paintMeter();
    paintUsed(k);
    paintSource(k);
  }

  // A skill brought in from a link keeps the link, so it can be checked for changes later.
  function paintSource(k) {
    $('#source').hidden = !k.source;
    if (!k.source) return;
    $('#sourceLink').href = k.source.url;
    $('#sourceLink').textContent = k.source.url;
  }

  function paintMeter() {
    const n = f.body.value.length;
    $('#meter').textContent = `${n.toLocaleString()} characters · about ${Math.round(n / 4).toLocaleString()} tokens each time it is used`;
  }

  const checkbox = (value, label, checked, kind, hint = '') => {
    const input = el('input', { type: 'checkbox', value, checked });
    input.dataset.kind = kind;
    return el('label', { className: 'check' }, input, el('span', {}, label, hint ? el('small', { className: 'muted', textContent: ` ${hint}` }) : ''));
  };

  // Projects and agents that use the skill. The boxes show what is saved; Save applies what they show.
  function paintUsed(k) {
    const inProject = new Set(projects.filter((p) => (p.skills || []).includes(k.id)).map((p) => p.id));
    $('#projects').replaceChildren(...(projects.length
      ? projects.map((p) => checkbox(p.id, p.name, inProject.has(p.id), 'project'))
      : [el('span', { className: 'muted small', textContent: 'No projects yet.' })]));
    if (agents === null) { $('#agents').replaceChildren(el('span', { className: 'muted small', textContent: 'Agents are not reachable from this page.' })); return; }
    const onAgent = new Set(agents.filter((a) => (a.skills || []).some((s) => s.id === k.id)).map((a) => a.id));
    $('#agents').replaceChildren(...(agents.length
      ? agents.map((a) => checkbox(a.id, a.name || a.id, onAgent.has(a.id), 'agent', a.repo || ''))
      : [el('span', { className: 'muted small', textContent: 'No agents yet.' })]));
  }

  // The skill as the editor has it now.
  const fromForm = (id) => ({
    id,
    name: M.cleanName(f.name.value),
    description: f.description.value.trim(),
    body: f.body.value,
    disabled: !f.enabled.checked,
    source: skills.find((x) => x.id === id)?.source,
  });

  const usedFromForm = () => {
    const pick = (box, kind) => new Map([...box.querySelectorAll(`input[data-kind="${kind}"]`)].map((i) => [i.value, i.checked]));
    return { projects: pick($('#projects'), 'project'), agents: agents ? pick($('#agents'), 'agent') : new Map() };
  };

  // ---- saving ---------------------------------------------------------------
  // The one place that changes skills: the skill list, the projects that keep ids, and the agents' copies.
  // usedBy = { projects, agents } (Maps of id -> bool) from the editor's boxes, or null to leave who uses it alone
  // (turning on or off, importing). gone = the skill is deleted: no project or agent keeps it.
  async function commit(skill, usedBy, gone = false) {
    const nextSkills = gone ? skills.filter((k) => k.id !== skill.id)
      : skills.some((k) => k.id === skill.id) ? skills.map((k) => (k.id === skill.id ? skill : k)) : [...skills, skill];
    const nextProjects = projects.map((p) => {
      const change = gone ? { id: skill.id, on: false } : usedBy ? { id: skill.id, on: usedBy.projects.get(p.id) === true } : null;
      return { ...p, skills: M.projectSkillsAfter(p, nextSkills, change) };
    });
    skills = nextSkills;
    draft = null;
    selected = gone ? (skills[0]?.id ?? null) : skill.id;
    try {
      await store(KEYS.skills, skills);
      if (!same(projects, nextProjects)) { projects = nextProjects; await store(KEYS.projects, projects); }
    } catch (err) { toast(err.message, true); }
    await syncAgents(skill, usedBy, gone);
    paintAll();
  }

  // Each agent's copy: this skill is added, refreshed or dropped as the box says; a skill that is off or gone is dropped.
  async function syncAgents(skill, usedBy, gone) {
    if (!agents) return;
    for (const a of agents) {
      const change = gone ? { id: skill.id, on: false } : usedBy ? { id: skill.id, on: usedBy.agents.get(a.id) === true } : null;
      const next = M.agentSkillsAfter(a, skills, change);
      if (!next) continue;
      try {
        const r = await fetch(`api/agents/${encodeURIComponent(a.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skills: next }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        a.skills = next;
      } catch (err) { toast(`${a.name || a.id}: ${err.message}`, true); }
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = fromForm(selected);
    const bad = M.problem(k, skills);
    if (bad) { $('#status').textContent = bad; toast(bad, true); return; }
    $('#save').disabled = true;
    try {
      await commit(k, usedFromForm());
      $('#status').textContent = 'Saved';
    } finally { $('#save').disabled = false; }
  });

  $('#delete').addEventListener('click', async () => {
    const k = skills.find((x) => x.id === selected);
    if (!k || !await ui.confirm(`Delete the skill “${k.name}”? Projects and agents stop using it.`, { ok: 'Delete', danger: true })) return;
    await commit(k, null, true);
    toast(`Deleted ${k.name}`);
  });

  // Off takes the skill away from agents (they keep no copy of it) and from chats; projects keep the link, so turning it on again restores them.
  async function toggle(id) {
    const k = skills.find((x) => x.id === id);
    if (!k) return;
    await commit({ ...k, disabled: !k.disabled }, null);
  }

  $('#new').addEventListener('click', () => {
    draft = { id: uid(), name: M.freeName('new-skill', skills), description: '', body: '', disabled: false };
    selected = draft.id;
    paintAll();
    f.name.focus();
  });

  $('#search').addEventListener('input', (e) => { query = e.target.value; paintList(); });
  f.body.addEventListener('input', paintMeter);

  // Import: each file becomes one skill, named from its frontmatter (or the file name), never taking a name in use.
  $('#import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async (e) => {
    const added = [];
    for (const file of e.target.files) {
      const parsed = M.parseSkillFile(await file.text(), file.name.replace(/\.(md|markdown|txt)$/i, ''));
      if (!parsed.body) { toast(`${file.name} has no instructions in it.`, true); continue; }
      added.push({ id: uid(), name: M.freeName(parsed.name, [...skills, ...added]), description: parsed.description, body: parsed.body, disabled: false });
    }
    e.target.value = '';
    if (!added.length) return;
    skills = [...skills, ...added];
    draft = null;
    selected = added[0].id;
    try { await store(KEYS.skills, skills); } catch (err) { toast(err.message, true); }
    paintAll();
    toast(`Imported ${added.length} skill${added.length === 1 ? '' : 's'}`);
  });

  // ---- from a link ---------------------------------------------------------
  // The dialog shows what the link holds; nothing is saved until Import. Checking a skill's source uses the same
  // dialog with the one skill, and Update replaces its instructions (its name and its uses stay).
  const remote = $('#remote');
  let remoteItems = [];  // what the last look found, each with pick: whether Import takes it
  let remoteFor = null;  // the skill being updated from its source, or null when importing

  // A name the page can keep: letters, digits, dashes, dots, underscores. Odd characters become dashes.
  const safeName = (n) => String(n || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');

  // Why an item cannot be taken, or null. Importing gives a free name, so only the instructions can be wrong.
  const remoteProblem = (i) => i.error
    || (remoteFor ? M.problem({ ...remoteFor, description: i.description, body: i.body }, skills)
      : M.problem({ name: M.freeName(safeName(i.name), skills), body: i.body }, skills));

  const sameAsCopy = (i) => Boolean(remoteFor) && i.body === remoteFor.body && (i.description || '') === (remoteFor.description || '');

  function openRemote(skill = null) {
    remoteFor = skill;
    $('#remoteTitle').textContent = skill ? `Update “${skill.name}” from its source` : 'Import skills from a link';
    $('#remoteLook').hidden = !!skill;
    $('#remoteUrl').value = '';
    remoteItems = [];
    paintRemote();
    remote.showModal();
    if (skill) look(skill.source.file);
    else $('#remoteUrl').focus();
  }

  const setRemoteStatus = (text, bad = false) => { $('#remoteStatus').textContent = text; $('#remoteStatus').classList.toggle('bad', bad); };

  async function look(url) {
    $('#remoteGo').disabled = true;
    setRemoteStatus(remoteFor ? 'Checking the source…' : 'Looking…');
    try {
      const r = await fetch('api/skills/remote', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ url }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      remoteItems = data.items.map((i) => ({ ...i, pick: !remoteProblem(i) && !sameAsCopy(i) }));
      const found = remoteItems.length;
      const more = data.truncated ? ` The first ${found} are shown.` : '';
      setRemoteStatus(remoteFor ? (sameAsCopy(remoteItems[0]) ? 'Already up to date.' : 'There is a newer version.')
        : found ? `Found ${found} ${found === 1 ? 'file' : 'files'}. Pick what to import.${more}` : 'Nothing found there.');
    } catch (err) {
      remoteItems = [];
      setRemoteStatus(err.message, true);
    } finally {
      $('#remoteGo').disabled = false;
    }
    paintRemote();
  }

  function paintRemote() {
    $('#remoteList').replaceChildren(...remoteItems.map((i) => {
      const bad = remoteProblem(i);
      const same = !bad && sameAsCopy(i);
      const box = el('input', { type: 'checkbox', checked: i.pick, disabled: !!bad || same });
      box.addEventListener('change', () => { i.pick = box.checked; paintRemoteButton(); });
      return el('div', { className: 'remote-item' },
        el('label', { className: 'check' }, box, el('span', {}, el('b', { textContent: i.name || '(no name)' }), el('small', { className: 'muted', textContent: ` ${i.description || ''}` }))),
        i.body ? el('details', {}, el('summary', { className: 'muted small', textContent: 'Read the instructions' }), el('pre', { textContent: i.body })) : '',
        el('small', { className: bad ? 'bad' : 'muted', textContent: bad || (same ? 'The same as the copy you have.' : `${i.body.length.toLocaleString()} characters`) }),
        el('a', { className: 'small', href: i.page, target: '_blank', rel: 'noopener noreferrer', textContent: i.page }));
    }));
    paintRemoteButton();
  }

  function paintRemoteButton() {
    const count = remoteItems.filter((i) => i.pick && !remoteProblem(i)).length;
    const go = $('#remoteImport');
    go.disabled = !count;
    go.textContent = remoteFor ? 'Update' : count ? `Import ${count}` : 'Import';
  }

  $('#importUrl').addEventListener('click', () => openRemote());
  $('#remoteLook').addEventListener('submit', (e) => { e.preventDefault(); look($('#remoteUrl').value.trim()); });
  $('#remoteCancel').addEventListener('click', () => remote.close());
  remote.addEventListener('close', () => { remoteFor = null; });

  $('#remoteImport').addEventListener('click', async () => {
    const picked = remoteItems.filter((i) => i.pick && !remoteProblem(i));
    if (!picked.length) return;
    const fetchedAt = new Date().toISOString();
    const k = remoteFor;
    remote.close();
    if (k) {
      await commit({ ...k, description: picked[0].description, body: picked[0].body, source: { ...k.source, fetchedAt } }, null);
      toast(`Updated ${k.name}`);
      return;
    }
    const added = [];
    for (const i of picked) {
      added.push({ id: uid(), name: M.freeName(safeName(i.name), [...skills, ...added]), description: i.description, body: i.body, disabled: false, source: { url: i.page, file: i.url, fetchedAt } });
    }
    skills = [...skills, ...added];
    draft = null;
    selected = added[0].id;
    try { await store(KEYS.skills, skills); } catch (err) { toast(err.message, true); }
    paintAll();
    toast(`Imported ${added.length} skill${added.length === 1 ? '' : 's'}`);
  });

  $('#resync').addEventListener('click', () => {
    const k = skills.find((x) => x.id === selected);
    if (k?.source) openRemote(k);
  });

  // The .claude skills, read the first time the box opens (only the computer the harness runs on can read them)
  $('#kitBox').addEventListener('toggle', async (e) => {
    if (!e.target.open || kitItems) return;
    $('#kitList').replaceChildren(el('li', { className: 'muted small', textContent: 'Looking…' }));
    try {
      const r = await fetch('api/claude-kit', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      kitItems = ((await r.json()).items || []).filter((i) => i.kind === 'skill');
    } catch (err) {
      kitItems = [];
      $('#kitList').replaceChildren(el('li', { className: 'muted small', textContent: `Not available here: ${err.message}` }));
      return;
    }
    paintKit();
  });

  function paintKit() {
    if (!kitItems.length) { $('#kitList').replaceChildren(el('li', { className: 'muted small', textContent: 'Nothing found in .claude/skills.' })); return; }
    const names = new Set(skills.map((k) => k.name.toLowerCase()));
    $('#kitList').replaceChildren(...kitItems.map((i, n) => {
      const have = names.has(i.name.toLowerCase());
      return el('li', { className: 'kit-item' },
        el('b', { textContent: i.name }),
        el('small', { className: 'muted', textContent: `${i.description || ''} (${i.source})` }),
        el('button', { type: 'button', className: 'quiet', disabled: have, textContent: have ? 'Added' : 'Add', onclick: () => addKit(n) }));
    }));
  }

  async function addKit(n) {
    const i = kitItems[n];
    const k = { id: uid(), name: M.freeName(i.name, skills), description: i.description || '', body: i.body, disabled: false };
    draft = null;
    selected = k.id;
    await commit(k, null);
    toast(`Added ${k.name}`);
  }

  function paintAll() {
    paintList();
    paintEditor();
    if (kitItems) paintKit();
  }

  load();
})();
