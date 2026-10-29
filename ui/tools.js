// Tools page: add, edit, test, switch off and remove MCP servers. The server
// decides who may do what (admins, or this machine); this only draws the page.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return n;
  };
  const f = $('#editor');
  let data = { servers: [], catalog: [] };
  let editing = null; // the server being edited (null: a new one)

  const say = (text, bad) => { const m = $('#msg'); m.textContent = text || ''; m.classList.toggle('err', !!bad); };
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const act = (fn) => async (...a) => { try { say(''); await fn(...a); } catch (e) { say(e.message, true); ui.toast(e.message, { kind: 'error' }); } };
  // After adding: scroll the new server into view and flash it, so the move out of the catalog is seen
  function reveal(name) {
    const c = [...document.querySelectorAll('#list .srv')].find((n) => n.dataset.name === name);
    if (!c) return;
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.classList.add('fresh');
    setTimeout(() => c.classList.remove('fresh'), 2500);
  }
  function result(name, label, s) {
    const ok = s?.status === 'connected';
    const text = ok ? `${label} is connected with ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}.` : `${label} added, but it did not connect: ${s?.error || 'unknown error'}`;
    say(text, !ok);
    ui.toast(text, { kind: ok ? 'ok' : 'error' });
    reveal(name);
  }

  // ---- the servers ----------------------------------------------------------
  const STATUS = { connected: ['ok', 'Connected'], failed: ['bad', 'Failed'], disabled: ['', 'Off'], connecting: ['warn', 'Connecting…'] };

  function summary(s) {
    const sp = s.spec;
    return sp.type === 'stdio' ? [sp.command, ...(sp.args || [])].join(' ') : sp.url;
  }

  function draw() {
    $('#file').textContent = data.file ? data.file.split(/[\\/]/).pop() : 'mcp-servers.json';
    const list = $('#list');
    list.replaceChildren();
    if (data.error) list.append(el('p', { className: 'card err' }, `The file can't be read: ${data.error}`));
    if (!data.servers.length) list.append(el('p', { className: 'card muted empty' }, 'No servers yet. Add one below, or pick one from the popular servers.'));
    for (const s of data.servers) list.append(card(s));
    drawCatalog();
  }

  const count = (s) => `${s.tools.filter((t) => t.enabled).length} of ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'} offered`;

  function card(s) {
    const [cls, label] = STATUS[s.status] || ['', s.status];
    const head = el('div', { className: 'head' },
      el('span', { className: 'title' }, s.name),
      el('span', { className: `chip ${cls}` }, label),
      el('span', { className: 'chip' }, { stdio: 'program', http: 'HTTP', sse: 'SSE' }[s.spec.type]),
      s.status === 'connected' ? el('span', { className: 'muted count' }, count(s)) : null,
      el('span', { className: 'spacer' }),
    );
    const sw = el('label', { className: 'field check', title: 'Switch the server on or off' }, el('input', { type: 'checkbox', checked: s.status !== 'disabled' }), el('span', {}, 'On'));
    sw.firstChild.addEventListener('change', act(async (e) => { data = await api('POST', '/ui/api/mcp/patch', { name: s.name, disabled: !e.target.checked }); draw(); }));
    const edit = el('button', { type: 'button' }, 'Edit');
    edit.addEventListener('click', () => open(s));
    const remove = el('button', { type: 'button', className: 'quiet' }, 'Remove');
    remove.addEventListener('click', act(async () => {
      if (!await ui.confirm(`Remove "${s.name}"? Its entry is deleted from the file.`)) return;
      data = await api('POST', '/ui/api/mcp/remove', { name: s.name });
      say(`Removed ${s.name}.`);
      draw();
    }));
    head.append(sw, edit, remove);

    const c = el('div', { className: `card srv${s.status === 'disabled' ? ' off' : ''}` }, head, el('div', { className: 'what' }, summary(s)));
    c.dataset.name = s.name;
    if (s.error) c.append(el('div', { className: 'err' }, s.error));
    if (s.tools.length) c.append(toolList(s));
    return c;
  }

  // The server's own tools, each switchable; saved straight away
  function toolList(s) {
    const d = el('details', {}, el('summary', {}, 'Tools'));
    const save = act(async () => {
      const off = [...d.querySelectorAll('input')].filter((i) => !i.checked).map((i) => i.dataset.tool);
      data = await api('POST', '/ui/api/mcp/patch', { name: s.name, disabledTools: off });
      const again = data.servers.find((x) => x.name === s.name);
      if (again) { s.tools = again.tools; }
      d.closest('.srv').querySelector('.count').textContent = count(s);
      d.querySelectorAll('.tool').forEach((row) => row.classList.toggle('off', !row.querySelector('input').checked));
    });
    for (const t of s.tools) {
      const box = el('input', { type: 'checkbox', checked: t.enabled });
      box.dataset.tool = t.name;
      box.addEventListener('change', save);
      d.append(el('label', { className: `tool${t.enabled ? '' : ' off'}` }, box, el('span', {}, el('b', {}, t.name), t.description ? el('small', {}, t.description.slice(0, 160)) : null)));
    }
    return d;
  }

  // ---- the form -------------------------------------------------------------
  function addRow(kind, key = '', value = '', secret = false) {
    const row = el('div', { className: 'row' });
    const k = el('input', { placeholder: kind === 'env' ? 'NAME' : 'Header', value: key, spellcheck: false, autocapitalize: 'none' });
    const v = el('input', { placeholder: secret ? 'Saved, hidden. Type to replace' : 'value or ${NAME}', value, spellcheck: false, autocomplete: 'off' });
    v.dataset.keep = secret ? '1' : '';
    v.addEventListener('input', () => { v.dataset.keep = ''; });
    const x = el('button', { type: 'button', className: 'quiet', title: 'Remove this row' }, '×');
    x.addEventListener('click', () => row.remove());
    row.append(k, v, x);
    $(`[data-rows="${kind}"]`).append(row);
  }
  const rowsOf = (kind) => [...$(`[data-rows="${kind}"]`).children].map((r) => {
    const [k, v] = r.querySelectorAll('input');
    return v.dataset.keep ? { key: k.value.trim(), keep: true } : { key: k.value.trim(), value: v.value };
  }).filter((r) => r.key);

  function showKind() {
    const type = f.type.value;
    for (const g of f.querySelectorAll('.kind')) g.hidden = !g.dataset.kind.split(' ').includes(type);
  }
  f.type.addEventListener('change', showKind);
  f.addEventListener('click', (e) => { const b = e.target.closest('[data-addrow]'); if (b) addRow(b.dataset.addrow); });

  function open(server, template) {
    editing = server || null;
    const sp = (server && server.spec) || template?.spec || {};
    f.reset();
    $('[data-rows="env"]').replaceChildren();
    $('[data-rows="headers"]').replaceChildren();
    $('#testResult').hidden = true;
    $('#editorTitle').textContent = server ? `Edit ${server.name}` : template ? `Add ${template.name}` : 'Add a server';
    f.name.value = server ? server.name : template?.id || '';
    f.type.value = sp.type === 'http' || sp.type === 'sse' ? sp.type : sp.url ? 'http' : 'stdio';
    f.command.value = sp.command || '';
    f.args.value = (sp.args || []).join('\n');
    f.cwd.value = sp.cwd || '';
    f.url.value = sp.url || '';
    f.askBefore.value = sp.askBefore || '';
    for (const k of ['timeoutMs', 'retries', 'callTimeoutMs']) f[k].value = sp[k] ?? '';
    f.querySelector('.more').open = ['timeoutMs', 'retries', 'callTimeoutMs'].some((k) => sp[k] !== undefined);
    // from the server these are lists of { key, value } or { key, secret }; from the catalog, plain maps
    const rows = (v) => (Array.isArray(v) ? v : Object.entries(v || {}).map(([key, value]) => ({ key, value })));
    for (const r of rows(sp.env)) addRow('env', r.key, r.value || '', !!r.secret);
    for (const r of rows(sp.headers)) addRow('headers', r.key, r.value || '', !!r.secret);
    showKind();
    f.hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    (server ? f.command : f.name).focus();
  }
  $('#add').addEventListener('click', () => open());
  $('#close').addEventListener('click', () => { f.hidden = true; });

  function entry() {
    const type = f.type.value;
    const num = (n) => (f[n].value === '' ? undefined : Number(f[n].value));
    const common = { type, askBefore: f.askBefore.value, timeoutMs: num('timeoutMs'), retries: num('retries'), callTimeoutMs: num('callTimeoutMs') };
    if (type === 'stdio') return { ...common, command: f.command.value, args: f.args.value.split('\n').map((a) => a.trim()).filter(Boolean), cwd: f.cwd.value, env: rowsOf('env') };
    return { ...common, url: f.url.value, headers: rowsOf('headers') };
  }

  $('#test').addEventListener('click', act(async () => {
    const box = $('#testResult');
    box.hidden = false; box.className = 'test'; box.textContent = 'Connecting… the first start of an npx or uvx server can take a minute.';
    $('#test').disabled = true;
    try {
      const r = await api('POST', '/ui/api/mcp/test', { from: editing?.name, spec: entry() });
      box.className = `test ${r.ok ? 'ok' : 'bad'}`;
      box.replaceChildren(r.ok
        ? el('div', {}, `Connected in ${(r.ms / 1000).toFixed(1)} s. ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}:`, el('ul', {}, ...r.tools.map((t) => el('li', {}, t.name))))
        : el('div', {}, r.error || 'It did not connect.'));
    } catch (e) {
      box.className = 'test bad'; box.textContent = e.message;
    } finally {
      $('#test').disabled = false;
    }
  }));

  f.addEventListener('submit', act(async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    const save = $('#save'), box = $('#testResult');
    save.disabled = true; save.textContent = 'Saving and connecting…';
    box.hidden = false; box.className = 'test'; box.textContent = 'Saving and connecting… the first start of an npx or uvx server can take a minute.';
    try {
      data = await api('POST', '/ui/api/mcp/save', { from: editing?.name, name, spec: entry() });
      f.hidden = true;
      draw();
      result(name, name, data.servers.find((x) => x.name === name));
    } catch (err) {
      box.className = 'test bad'; box.textContent = `Not saved: ${err.message}`; // stays beside the Save button
      throw err;
    } finally {
      save.disabled = false; save.textContent = 'Save';
    }
  }));

  // ---- the catalog ----------------------------------------------------------
  function drawCatalog() {
    const have = new Set(data.servers.map((s) => s.name));
    const box = $('#catalog');
    box.replaceChildren();
    for (const c of data.catalog) {
      const added = have.has(c.id);
      const go = el('button', { type: 'button', className: `go${c.ready && !added ? ' primary' : ''}`, disabled: added }, added ? 'Added' : c.ready ? 'Add' : 'Set up…');
      const fail = el('small', { className: 'fail', role: 'alert', hidden: true });
      go.addEventListener('click', act(async () => {
        if (!c.ready) return open(null, c);
        fail.hidden = true;
        go.disabled = true; go.textContent = 'Adding…';
        try {
        data = await api('POST', '/ui/api/mcp/save', { name: c.id, spec: { ...c.spec, env: Object.entries(c.spec.env || {}).map(([key, value]) => ({ key, value })), headers: Object.entries(c.spec.headers || {}).map(([key, value]) => ({ key, value })) } });
        draw();
        result(c.id, c.name, data.servers.find((x) => x.name === c.id));
        } catch (e) {
          go.disabled = false; go.textContent = 'Add';
          fail.textContent = `Not added: ${e.message}`; fail.hidden = false;
          throw e;
        }
      }));
      box.append(el('div', { className: 'card' }, el('b', {}, c.name), el('p', {}, c.description), c.needs ? el('small', {}, c.needs) : null, go, fail));
    }
  }

  $('#reload').addEventListener('click', act(async () => {
    say('Reconnecting…');
    await api('POST', '/ui/api/tools/reload', {});
    await load();
    say('Reconnected.');
  }));

  async function load() {
    data = await api('GET', '/ui/api/mcp');
    draw();
  }
  load().catch((e) => say(/admins only|controls work only/.test(e.message) ? `${e.message}. Sign in as an admin, or open this page on the computer running the harness.` : e.message, true));
})();
