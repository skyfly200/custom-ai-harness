// "Change this page": a small button that lets you ask an app's own agent to change the page
// you are looking at. Add it to any page of the harness UI (or an app served from the same
// address):
//   <script src="agent-widget.js" data-app-name="Harness UI" defer></script>
// data-app takes the app's id instead. It stays hidden unless that app is registered on the
// Agents page. A request starts a change run with what you were looking at as context; its
// progress shows here and the review, preview and ship steps are on the Agents page.
'use strict';

/** A short, stable description of an element: tag#id.class, e.g. button#save.primary. */
function describe(el) {
  if (!el || !el.tagName) return '';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
  return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls.map((c) => `.${c}`).join('');
}

/** What the person was looking at, for the agent. Data only; it is told not to treat it as instructions. */
function buildContext({ page, title, element, selection, errors }) {
  const ctx = { page: String(page || '').slice(0, 300), title: String(title || '').slice(0, 200) };
  if (element) ctx.element = { selector: element.selector || '', text: String(element.text || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
  if (selection && String(selection).trim()) ctx.selectedText = String(selection).trim().slice(0, 300);
  if (errors && errors.length) ctx.consoleErrors = errors.slice(-5).map((e) => String(e).slice(0, 300));
  return ctx;
}

if (typeof module !== 'undefined') module.exports = { describe, buildContext };

if (typeof document !== 'undefined') (() => {
  const script = document.currentScript;
  const appId = script?.dataset.app || '';
  const appName = script?.dataset.appName || '';
  const api = (p) => new URL(`api/${p}`, script?.src || location.href).href;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`Unhandled rejection: ${e.reason?.message || e.reason}`));

  let app = null;
  let picked = null;
  let picking = false;
  let timer = null;
  const el = (tag, props = {}, html = '') => Object.assign(document.createElement(tag), props, html ? { innerHTML: html } : {});
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const style = el('style', {}, `
    .aw-btn { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; padding: 8px 14px; border-radius: 999px; border: 0; cursor: pointer; font: 600 13px system-ui, sans-serif; color: #fff; background: linear-gradient(135deg, #8b5cf6, #ec4899); box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .aw-panel { position: fixed; right: 16px; bottom: 60px; z-index: 2147483000; width: min(360px, calc(100vw - 32px)); padding: 12px; border-radius: 14px; background: #fff; color: #1b1630; border: 1px solid rgba(0,0,0,.12); box-shadow: 0 8px 30px rgba(0,0,0,.3); font: 13px system-ui, sans-serif; }
    .aw-panel[hidden] { display: none; }
    .aw-panel textarea { width: 100%; box-sizing: border-box; min-height: 70px; margin: 8px 0; font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(0,0,0,.2); resize: vertical; }
    .aw-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .aw-panel button { font: inherit; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.2); background: #f4f1ff; cursor: pointer; }
    .aw-panel button.aw-go { background: #7c3aed; color: #fff; border-color: #7c3aed; }
    .aw-panel .aw-note { color: #5d5775; margin-top: 6px; word-break: break-word; }
    .aw-hit { outline: 2px solid #ec4899 !important; outline-offset: 2px; cursor: crosshair !important; }
  `);
  const btn = el('button', { className: 'aw-btn', type: 'button', hidden: true, textContent: 'Change this page' });
  const panel = el('div', { className: 'aw-panel', hidden: true }, `
    <strong class="aw-title">Ask for a change</strong>
    <textarea placeholder="What should be different on this page?"></textarea>
    <div class="aw-row"><button type="button" class="aw-pick">Pick an element</button><span class="aw-picked"></span></div>
    <div class="aw-row" style="margin-top:8px"><button type="button" class="aw-go">Start the change</button><button type="button" class="aw-prop" title="The agent writes a fix and opens a pull request for a person to review. Nothing is merged or deployed.">Propose a fix only</button><button type="button" class="aw-close">Close</button></div>
    <div class="aw-note" aria-live="polite"></div>`);
  const q = (s) => panel.querySelector(s);

  function stopPicking() { picking = false; document.removeEventListener('mouseover', over, true); document.removeEventListener('mouseout', out, true); document.removeEventListener('click', choose, true); q('.aw-pick').textContent = 'Pick an element'; }
  const mine = (t) => t && (t === btn || panel.contains(t));
  function over(e) { if (!mine(e.target)) e.target.classList.add('aw-hit'); }
  function out(e) { e.target.classList.remove('aw-hit'); }
  function choose(e) {
    if (mine(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    e.target.classList.remove('aw-hit');
    picked = { selector: describe(e.target), text: e.target.innerText || e.target.value || '' };
    q('.aw-picked').textContent = picked.selector;
    stopPicking();
  }
  q('.aw-pick').addEventListener('click', () => {
    if (picking) return stopPicking();
    picking = true; q('.aw-pick').textContent = 'Click the element…';
    document.addEventListener('mouseover', over, true); document.addEventListener('mouseout', out, true); document.addEventListener('click', choose, true);
  });
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  q('.aw-close').addEventListener('click', () => { panel.hidden = true; stopPicking(); });

  async function poll(id) {
    clearTimeout(timer);
    try {
      const run = await (await fetch(api(`runs/${id}`))).json();
      const link = `<a href="${esc(new URL('agents.html', script?.src || location.href).href)}#${esc(id)}" target="_blank" rel="noopener">Review it on the Agents page</a>`;
      if (['queued', 'running', 'waiting'].includes(run.status)) {
        q('.aw-note').innerHTML = `${esc(run.status === 'waiting' ? 'Waiting for your OK on the Agents page' : `Working${run.stage ? ` (${run.stage})` : ''}…`)} ${link}`;
        timer = setTimeout(() => poll(id), 3000);
      } else {
        q('.aw-note').innerHTML = `Change ${esc(run.status)}. ${link}, where you can preview it and approve or undo.`;
        q('.aw-go').disabled = false; q('.aw-prop').disabled = false;
      }
    } catch (err) { q('.aw-note').textContent = err.message; q('.aw-go').disabled = false; }
  }
  async function send(path, extra, doneNote) {
    const text = q('textarea').value.trim();
    const context = buildContext({ page: location.pathname + location.hash, title: document.title, element: picked, selection: String(getSelection?.() || ''), errors });
    if (!text && !(extra.kind === 'error' && context.consoleErrors)) { q('.aw-note').textContent = 'Say what should change.'; return; }
    q('.aw-go').disabled = true; q('.aw-prop').disabled = true; q('.aw-note').textContent = 'Starting…';
    try {
      const res = await fetch(api(`apps/${app.id}/${path}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...extra, [path === 'changes' ? 'request' : 'note']: text, context }) });
      const run = await res.json();
      if (!res.ok) throw new Error(run.error || `HTTP ${res.status}`);
      q('textarea').value = '';
      poll(run.id);
    } catch (err) { q('.aw-note').textContent = err.message; q('.aw-go').disabled = false; q('.aw-prop').disabled = false; }
  }
  q('.aw-go').addEventListener('click', () => send('changes', {}));
  q('.aw-prop').addEventListener('click', () => send('proposals', { kind: errors.length ? 'error' : 'feedback' }));

  (async () => {
    try {
      const { apps } = await (await fetch(api('apps'))).json();
      app = apps.find((a) => (appId && a.id === appId) || (appName && a.name === appName));
    } catch { /* no runner, no widget */ }
    if (!app) return;
    q('.aw-title').textContent = `Ask ${app.name} for a change`;
    btn.hidden = false;
    document.head.append(style);
    document.body.append(btn, panel);
  })();
})();
