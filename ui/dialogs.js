'use strict';
// Our own replacements for the browser's alert(), confirm() and prompt().
// window.ui.toast(text, { kind: 'error' }), await ui.confirm(text, { ok, danger, title }),
// await ui.prompt(text, { value, ok, type, placeholder }) (null when cancelled).
// Never call the native ones: test/dialogs.test.js fails if they appear in ui/.
(() => {
  if (window.ui && window.ui.confirm) return;

  const css = `
.ui-toasts { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 1000; display: flex; flex-direction: column; gap: 8px; align-items: center; width: min(460px, calc(100vw - 32px)); pointer-events: none; }
.ui-toast { pointer-events: auto; background: var(--panel, #fff); color: var(--text, #1a1830); border: 1px solid var(--field-border, var(--border, #e2dfee)); border-left: 4px solid var(--accent, #6a4cf5); border-radius: 10px; padding: 9px 14px; font-size: 13px; line-height: 1.4; box-shadow: var(--shadow, 0 6px 24px rgba(0,0,0,.2)); max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; cursor: pointer; }
.ui-toast.error { border-left-color: var(--bad, #cf222e); }
.ui-toast.ok { border-left-color: var(--ok, #1a7f37); }
.ui-veil { position: fixed; inset: 0; z-index: 1001; background: rgba(10, 8, 25, .5); display: flex; align-items: center; justify-content: center; padding: 16px; }
.ui-dialog { background: var(--panel, #fff); color: var(--text, #1a1830); border: 1px solid var(--field-border, var(--border, #e2dfee)); border-radius: 14px; box-shadow: var(--shadow, 0 10px 40px rgba(0,0,0,.35)); width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 18px 18px 14px; }
.ui-dialog h3 { margin: 0 0 8px; font-size: 15px; }
.ui-dialog p { margin: 0 0 12px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.ui-dialog input { width: 100%; box-sizing: border-box; margin: 0 0 12px; padding: 8px 10px; font: inherit; color: var(--text, #1a1830); background: var(--bg, #f5f4fb); border: 1px solid var(--field-border, var(--border, #e2dfee)); border-radius: 8px; }
.ui-dialog input:focus-visible { outline: 2px solid var(--accent, #6a4cf5); outline-offset: 1px; }
.ui-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.ui-actions button.danger { background: var(--bad, #cf222e); border-color: var(--bad, #cf222e); color: #fff; }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let toasts;
  function toast(text, opts = {}) {
    if (!toasts) {
      toasts = document.createElement('div');
      toasts.className = 'ui-toasts';
      toasts.setAttribute('role', 'status');
      toasts.setAttribute('aria-live', 'polite');
      document.body.appendChild(toasts);
    }
    const t = document.createElement('div');
    t.className = `ui-toast${opts.kind ? ` ${opts.kind}` : ''}`;
    t.textContent = String(text ?? '');
    const close = () => t.remove();
    t.addEventListener('click', close);
    toasts.appendChild(t);
    while (toasts.children.length > 4) toasts.firstChild.remove();
    setTimeout(close, opts.ms || (opts.kind === 'error' ? 7000 : 4000));
  }

  const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [href], select, textarea, [tabindex]:not([tabindex="-1"])';

  // One modal at a time; a second request waits for the first.
  let queue = Promise.resolve();
  function modal(build) {
    const run = () => new Promise((resolve) => {
      const opener = document.activeElement;
      const veil = document.createElement('div');
      veil.className = 'ui-veil';
      const box = document.createElement('div');
      box.className = 'ui-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      veil.appendChild(box);
      const done = (value) => {
        document.removeEventListener('keydown', onKey, true);
        veil.remove();
        if (opener && opener.focus) try { opener.focus(); } catch {}
        resolve(value);
      };
      const { focus, submit } = build(box, done);
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); e.stopPropagation(); submit(); }
        else if (e.key === 'Tab') {
          const els = [...box.querySelectorAll(FOCUSABLE)];
          if (!els.length) return;
          const first = els[0], last = els[els.length - 1];
          if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      document.addEventListener('keydown', onKey, true);
      veil.addEventListener('mousedown', (e) => { if (e.target === veil) done(null); });
      document.body.appendChild(veil);
      (focus() || box.querySelector('button')).focus();
    });
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  }

  function parts(box, text, opts) {
    if (opts.title) { const h = document.createElement('h3'); h.textContent = opts.title; box.appendChild(h); }
    const p = document.createElement('p');
    p.textContent = String(text ?? '');
    box.appendChild(p);
  }
  function button(label, cls, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', onclick);
    return b;
  }

  function confirm(text, opts = {}) {
    return modal((box, done) => {
      parts(box, text, opts);
      const row = document.createElement('div');
      row.className = 'ui-actions';
      const ok = button(opts.ok || 'OK', opts.danger ? 'primary danger' : 'primary', () => done(true));
      row.append(button(opts.cancel || 'Cancel', '', () => done(false)), ok);
      box.appendChild(row);
      // Escape resolves false for a confirm
      return { focus: () => (opts.danger ? row.firstChild : ok), submit: () => done(true) };
    }).then((v) => v === true);
  }

  function prompt(text, opts = {}) {
    return modal((box, done) => {
      parts(box, text, opts);
      const input = document.createElement('input');
      input.type = opts.type || 'text';
      input.value = opts.value ?? '';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.setAttribute('aria-label', String(text ?? ''));
      input.autocomplete = 'off';
      box.appendChild(input);
      const row = document.createElement('div');
      row.className = 'ui-actions';
      const submit = () => done(input.value);
      row.append(button(opts.cancel || 'Cancel', '', () => done(null)), button(opts.ok || 'OK', 'primary', submit));
      box.appendChild(row);
      return { focus: () => { setTimeout(() => input.select(), 0); return input; }, submit };
    });
  }

  window.ui = { toast, confirm, prompt };
})();
