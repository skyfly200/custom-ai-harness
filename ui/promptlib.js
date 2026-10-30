'use strict';
// Saved prompts for any page: window.Prompts. The Agents page's new-run form uses it to offer a saved
// prompt and to save a run's prompt; the Prompts page uses it for everything.
//   await Prompts.list()                      -> [{ id, name, text, tags, suits, variables, tokens, versions }]
//   await Prompts.save({ id?, name, text, tags, suits, note })
//   await Prompts.pick({ agent, workflow })   -> { prompt, text } with variables filled in, or null
//   Prompts.variables(text), Prompts.render(text, values), Prompts.tokens(text)
// The pure helpers also run in Node tests (require).
(function (root) {
  const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  const variables = (text) => [...new Set([...String(text || '').matchAll(VAR)].map((m) => m[1]))];
  const render = (text, values = {}) => String(text || '').replace(VAR, (whole, name) => (values[name] != null && String(values[name]).length ? String(values[name]) : whole));
  const tokens = (text) => Math.ceil(String(text || '').length / 4);
  // "Fix the login bug" -> a short name from the first line
  const nameFrom = (text) => String(text || '').trim().split('\n')[0].replace(/\{\{|\}\}/g, '').slice(0, 60).trim();
  const api = { variables, render, tokens, nameFrom };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  async function call(method, path, body) {
    const res = await fetch(`api/prompts${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }
  const load = () => call('GET', '');
  api.list = async () => (await load()).prompts;
  api.starters = async () => (await load()).starters;
  api.get = (id) => call('GET', `/${encodeURIComponent(id)}`);
  api.save = (p) => call('POST', '', p);
  api.remove = (id) => call('DELETE', `/${encodeURIComponent(id)}`);
  api.restore = (id, version) => call('POST', `/${encodeURIComponent(id)}/restore`, { version });

  // Ask a model to rewrite `text` more clearly. `model` is a name the Gateway serves; omit it to let the harness route.
  api.improve = async (text, notes, model) => {
    const { messages } = await (await fetch('api/prompts-improve', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, notes }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r; })).json();
    const headers = { 'content-type': 'application/json', 'x-harness-client': 'prompt improve' };
    if (model) headers['x-harness-model'] = model;
    const res = await fetch('../v1/chat/completions', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ model: 'harness', stream: false, messages }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && (j.error.message || j.error)) || `HTTP ${res.status}`);
    const out = String(j.choices?.[0]?.message?.content || '').trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/, '$1');
    if (!out) throw new Error('the model sent nothing back');
    return out;
  };

  // The values form: one input per variable. Returns the rendered text on Use, null on cancel.
  function fillDialog(name, text) {
    const names = variables(text);
    if (!names.length) return Promise.resolve(text);
    return window.ui.dialog((box, close) => {
      const h = document.createElement('h3'); h.textContent = name; box.appendChild(h);
      const inputs = {};
      for (const n of names) {
        const l = document.createElement('label'); l.style.cssText = 'display:block;font-size:12px;margin:0 0 4px;color:var(--muted)'; l.textContent = n.replace(/_/g, ' ');
        const i = document.createElement('input'); i.placeholder = n; inputs[n] = i;
        box.append(l, i);
      }
      const row = document.createElement('div'); row.className = 'ui-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => close(null);
      const use = document.createElement('button'); use.type = 'button'; use.className = 'primary'; use.textContent = 'Use prompt';
      use.onclick = () => close(render(text, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]))));
      row.append(cancel, use); box.appendChild(row);
      return inputs[names[0]];
    });
  }

  // A list to choose from (best matches for the agent or workflow first), then the variables form.
  api.pick = async ({ agent, workflow } = {}) => {
    const { prompts, starters } = await load();
    const fit = (p) => (agent && p.suits?.agent === agent ? 2 : 0) + (workflow && p.suits?.workflow === workflow ? 1 : 0);
    const mine = [...prompts].sort((a, b) => fit(b) - fit(a) || b.updated - a.updated);
    const chosen = await window.ui.dialog((box, close) => {
      const h = document.createElement('h3'); h.textContent = 'Use a saved prompt'; box.appendChild(h);
      const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;max-height:50vh;overflow:auto';
      const add = (p, label) => {
        const b = document.createElement('button'); b.type = 'button'; b.style.cssText = 'text-align:left;display:block';
        const t = document.createElement('b'); t.textContent = p.name;
        const s = document.createElement('small'); s.style.cssText = 'display:block;opacity:.75;white-space:normal'; s.textContent = `${label}${p.text.replace(/\s+/g, ' ').slice(0, 90)}`;
        b.append(t, s); b.onclick = () => close(p); list.appendChild(b);
      };
      mine.forEach((p) => add(p, ''));
      if (!mine.length) { const e = document.createElement('p'); e.textContent = 'You have no saved prompts yet. These starters are a good start.'; list.appendChild(e); }
      starters.forEach((p) => add(p, 'Starter · '));
      box.appendChild(list);
      const row = document.createElement('div'); row.className = 'ui-actions';
      const a = document.createElement('a'); a.href = 'prompts'; a.textContent = 'Open the Prompts page'; a.style.marginRight = 'auto';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => close(null);
      row.append(a, cancel); box.appendChild(row);
      return list.querySelector('button');
    });
    if (!chosen) return null;
    const text = await fillDialog(chosen.name, chosen.text);
    return text == null ? null : { prompt: chosen, text };
  };
  root.Prompts = api;
})(typeof window !== 'undefined' ? window : globalThis);
