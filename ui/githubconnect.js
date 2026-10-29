'use strict';
// The GitHub connection, in a dialog that opens only when it is needed (not connected yet, or "Manage").
// githubConnect.open({ back: 'chat' | 'agents' }) resolves after the dialog closes; githubConnect.line(el, st) fills a one-line summary.
(() => {
  async function getJson(url, opts) {
    const res = await fetch(url, opts);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }
  const me = (method, body) => getJson('api/me/github', { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  }

  async function open({ back = 'chat' } = {}) {
    let changed = false;
    await ui.dialog((box, close) => {
      box.append(el('h3', { textContent: 'GitHub' }));
      const note = el('p', { className: 'muted', textContent: 'Checking…' });
      const actions = el('div', { className: 'ui-actions' });
      const extra = el('div');
      box.append(note, extra, actions);
      const closeBtn = el('button', { type: 'button', textContent: 'Close' });
      closeBtn.addEventListener('click', () => close(null));

      async function draw() {
        extra.replaceChildren();
        actions.replaceChildren();
        let st = {}; let mine = null;
        try { st = await getJson('api/github/status'); } catch { /* shown below */ }
        try { mine = await me('GET'); } catch { /* no hosted database: nothing to manage here */ }
        const connected = !!st.connected;
        note.textContent = connected
          ? `Connected as ${st.login || 'your account'}${st.via === 'env' ? ' (GITHUB_TOKEN in .env)' : st.via === 'oauth' ? ' with GitHub' : ''}. Agents and chats can reach the repos this connection allows.`
          : st.note || 'Not connected. Public repos work without it; private repos and pushing need a connection.';
        if (connected && st.app && st.installUrl) extra.append(el('p', { className: 'small' }, el('a', { href: st.installUrl, target: '_blank', rel: 'noopener', textContent: 'Choose which repos it can reach' })));
        if (mine) {
          if (mine.oauth) {
            const b = el('button', { type: 'button', className: 'primary', textContent: connected ? 'Reconnect with GitHub' : 'Connect with GitHub' });
            b.addEventListener('click', () => { location.href = `api/me/github/connect?back=${encodeURIComponent(back)}`; });
            actions.append(b);
          }
          const form = el('form', { className: 'repo-input', autocomplete: 'off' });
          const token = el('input', { type: 'password', placeholder: mine.github?.set ? 'Paste a new token to replace it' : 'github_pat_…', autocomplete: 'off', spellcheck: false });
          token.setAttribute('aria-label', 'GitHub token');
          form.append(token, el('button', { type: 'submit', className: 'primary', textContent: 'Use token' }));
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!token.value.trim()) return token.focus();
            try { await me('PUT', { token: token.value.trim() }); changed = true; ui.toast('GitHub connected.', { kind: 'ok' }); await draw(); } catch (err) { ui.toast(err.message, { kind: 'error' }); }
          });
          extra.append(el('details', {}, el('summary', { className: 'muted small', textContent: 'Use a personal access token instead' }), el('p', { className: 'muted small', textContent: 'A fine-grained token with Contents: read and write on the repos you want. It is kept encrypted.' }), form));
          if (mine.github?.set) {
            const off = el('button', { type: 'button', textContent: 'Disconnect' });
            off.addEventListener('click', async () => {
              if (!await ui.confirm('Disconnect GitHub? Agents can no longer reach your private repos.', { ok: 'Disconnect', danger: true })) return;
              try { await me('DELETE'); changed = true; await draw(); } catch (err) { ui.toast(err.message, { kind: 'error' }); }
            });
            actions.append(off);
          }
        }
        actions.append(closeBtn);
      }
      draw();
      return closeBtn;
    });
    return changed;
  }

  window.githubConnect = { open };
})();
