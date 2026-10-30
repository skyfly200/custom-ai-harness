// Prompts page: a library on the left, the editor on the right. The server stores the prompts (per person);
// this only draws them. Improve asks a model through the harness (Prompts.improve in promptlib.js).
(() => {
  const $ = (s) => document.querySelector(s);
  const form = $('#editor');
  const f = form.elements; // not form.name: that is the form's own name
  const P = window.Prompts;
  let data = { prompts: [], starters: [] };
  let current = null;   // the saved prompt being edited (null: a new one)
  let tag = '';

  const toast = (t, bad) => ui.toast(t, bad ? { kind: 'error' } : {});
  const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
  const el = (tagName, props = {}, ...kids) => { const n = Object.assign(document.createElement(tagName), props); n.append(...kids); return n; };

  const body = () => ({
    name: f.name.value.trim(), text: f.text.value, tags: f.tags.value, note: f.note.value.trim(),
    suits: { agent: f.agent.value.trim(), workflow: f.workflow.value.trim() },
  });

  function paintMeter() {
    const n = P.tokens(f.text.value);
    const cost = (n * 3) / 1e6; // a $3 per million tokens model, as a yardstick
    $('#meter').textContent = `${f.text.value.length.toLocaleString()} characters · about ${n.toLocaleString()} tokens · roughly $${cost < 0.001 ? '0.001' : cost.toFixed(3)} to read on a $3 per million model`;
    const names = P.variables(f.text.value);
    const box = $('#vars');
    box.replaceChildren(...(names.length ? [el('span', { className: 'muted', textContent: 'Fill in when used:' }), ...names.map((n2) => el('code', { textContent: `{{${n2}}}` }))] : [el('span', { className: 'muted', textContent: 'No variables. Use {{name}} for anything that changes each time.' })]));
  }

  function show(p, isStarter) {
    current = isStarter ? null : p;
    f.name.value = p ? p.name : '';
    f.tags.value = p ? (p.tags || []).join(', ') : '';
    f.agent.value = p?.suits?.agent || '';
    f.workflow.value = p?.suits?.workflow || '';
    f.text.value = p ? p.text : '';
    f.note.value = '';
    $('#suggest').hidden = true;
    $('#delete').hidden = !current;
    $('#saveCopy').hidden = !current;
    $('#save').textContent = current ? 'Save' : 'Save prompt';
    paintMeter();
    paintHistory();
    paintList();
  }

  function paintHistory() {
    const box = $('#history');
    const vs = current ? [...current.versions].reverse() : [];
    $('#historyBox').hidden = vs.length < 2;
    box.replaceChildren(...vs.map((v, i) => el('div', { className: 'ver' },
      el('span', { textContent: `Version ${v.n}${i === 0 ? ' (current)' : ''} · ${new Date(v.at).toLocaleString()}${v.note ? ` · ${v.note}` : ''}` }),
      ...(i === 0 ? [] : [
        el('button', { type: 'button', className: 'quiet', textContent: 'View', onclick: act(() => viewVersion(v.n)) }),
        el('button', { type: 'button', className: 'quiet', textContent: 'Restore', onclick: act(() => restore(v.n)) }),
      ]))));
  }
  async function viewVersion(n) {
    const full = await P.get(current.id);
    const v = full.history.find((x) => x.n === n);
    await ui.dialog((box, close) => {
      box.append(el('h3', { textContent: `Version ${n}` }), el('pre', { textContent: v.text, style: 'white-space:pre-wrap;max-height:50vh;overflow:auto;font-size:12.5px' }));
      const row = el('div', { className: 'ui-actions' }, el('button', { type: 'button', textContent: 'Close', onclick: () => close(null) }));
      box.append(row);
      return row.firstChild;
    });
  }
  async function restore(n) {
    const p = await P.restore(current.id, n);
    await refresh(p.id);
    toast(`Restored version ${n} as a new version`);
  }

  function paintList() {
    const q = $('#search').value.trim().toLowerCase();
    const match = (p) => (!tag || (p.tags || []).includes(tag)) && (!q || `${p.name} ${(p.tags || []).join(' ')} ${p.text}`.toLowerCase().includes(q));
    const item = (p, starter) => {
      const b = el('button', { type: 'button', className: !starter && current && current.id === p.id ? 'on' : '' },
        el('b', { textContent: p.name }), el('small', { textContent: p.text.replace(/\s+/g, ' ') }));
      b.onclick = () => show(p, starter);
      return b;
    };
    const mine = data.prompts.filter(match);
    $('#list').replaceChildren(...(mine.length ? mine.map((p) => item(p, false)) : [el('small', { className: 'muted', textContent: data.prompts.length ? 'Nothing matches.' : 'Nothing saved yet. Pick a starter below or press New prompt.' })]));
    $('#starters').replaceChildren(...data.starters.filter(match).map((p) => item(p, true)));
    const tags = [...new Set([...data.prompts, ...data.starters].flatMap((p) => p.tags || []))].sort();
    $('#tags').replaceChildren(...tags.map((t) => el('button', { type: 'button', textContent: t, className: t === tag ? 'on' : '', onclick: () => { tag = tag === t ? '' : t; paintList(); } })));
  }

  async function refresh(selectId) {
    data = await (await fetch('api/prompts', { credentials: 'same-origin' })).json();
    const p = selectId ? data.prompts.find((x) => x.id === selectId) : null;
    if (p) { current = p; show(p, false); } else paintList();
  }

  form.addEventListener('submit', act(async (e) => {
    e.preventDefault();
    const p = await P.save({ ...body(), id: current ? current.id : undefined });
    await refresh(p.id);
    toast('Saved');
  }));
  $('#saveCopy').onclick = act(async () => {
    const b = body();
    const p = await P.save({ ...b, name: `${b.name} (copy)`, note: '' });
    await refresh(p.id);
    toast('Saved as a new prompt');
  });
  $('#delete').onclick = act(async () => {
    if (!(await ui.confirm(`Delete “${current.name}” and its history?`, { ok: 'Delete', danger: true }))) return;
    await P.remove(current.id);
    current = null;
    await refresh();
    show(null);
  });
  $('#new').onclick = () => { show(null); f.name.focus(); };
  $('#copy').onclick = act(async () => {
    const names = P.variables(f.text.value);
    let text = f.text.value;
    if (names.length) {
      text = await ui.dialog((box, close) => {
        box.append(el('h3', { textContent: 'Fill in the variables' }));
        const inputs = names.map((n) => { const i = el('input', { placeholder: n }); box.append(el('label', { textContent: n, style: 'display:block;font-size:12px;color:var(--muted);margin-bottom:4px' }), i); return [n, i]; });
        const row = el('div', { className: 'ui-actions' }, el('button', { type: 'button', textContent: 'Cancel', onclick: () => close(null) }), el('button', { type: 'button', className: 'primary', textContent: 'Copy', onclick: () => close(P.render(f.text.value, Object.fromEntries(inputs.map(([n, i]) => [n, i.value])))) }));
        box.append(row);
        return inputs[0][1];
      });
      if (text == null) return;
    }
    await navigator.clipboard.writeText(text);
    toast('Copied');
  });
  $('#improve').onclick = act(async () => {
    if (!f.text.value.trim()) return toast('Write the prompt first', true);
    const btn = $('#improve');
    btn.disabled = true; btn.textContent = 'Improving…';
    try {
      $('#suggestText').value = await P.improve(f.text.value, $('#improveNotes').value);
      $('#suggest').hidden = false;
    } finally { btn.disabled = false; btn.textContent = 'Improve with a model'; }
  });
  $('#accept').onclick = () => { f.text.value = $('#suggestText').value; f.note.value = f.note.value || 'Improved with a model'; $('#suggest').hidden = true; paintMeter(); };
  $('#discard').onclick = () => { $('#suggest').hidden = true; };
  f.text.addEventListener('input', paintMeter);
  $('#search').addEventListener('input', paintList);

  // names for the "suits" suggestions; either list failing just leaves the field free-form
  fetch('api/workflows', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { $('#workflowNames').replaceChildren(...(j.workflows || []).map((w) => el('option', { value: w.id, textContent: w.name }))); }).catch(() => {});
  fetch('api/agents', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { $('#agentNames').replaceChildren(...((j.agents || j) || []).map((a) => el('option', { value: a.name || a.id }))); }).catch(() => {});

  refresh().then(() => {
    const id = location.hash.slice(1);
    const hit = id && data.prompts.find((p) => p.id === id);
    show(hit || null, false);
    if (!hit) { const t = new URLSearchParams(location.search).get('text'); if (t) f.text.value = t; paintMeter(); }
  }).catch((e) => toast(e.message, true));
})();
