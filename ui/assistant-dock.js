// The assistant, one tap away on every page: a small "Assistant" button in the bottom-left corner that opens a
// panel. It talks to the same conversation as the Assistant page (utils/assistant.js), so a message sent here
// shows up there too. Each message carries the page you are on (and any text you had selected) so the assistant
// can answer about what is in front of you. The page context is shown in the panel, and only the page's path,
// title and selection are sent; the server caps and sanitises them (utils/assistant.js pageContext).
//
// Added by nav.js to every page that has the site navigation, except the Assistant page itself. Hidden unless the
// signed-in person may use the assistant (the owner, or an admin), so other people never see it.
'use strict';

/** What to send with a message: the page path (with the hash, so the chat id counts), its title and the selection. */
function gatherContext({ pathname = '', hash = '', title = '', selection = '' } = {}) {
  return { page: `${pathname}${hash}`, title: String(title || ''), selection: String(selection || '').trim() };
}

if (typeof module !== 'undefined') module.exports = { gatherContext };

if (typeof document !== 'undefined') (() => {
  const script = document.currentScript;
  if (!script || document.querySelector('.ad-btn')) return;
  const api = (p) => new URL(`api/${p}`, script.src).href;
  const pageUrl = new URL('assistant.html', script.src).href;
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

  // The last text selected outside the panel, so it still counts once the person has clicked into the panel.
  let lastSelection = '';
  document.addEventListener('selectionchange', () => {
    const sel = String(getSelection?.() || '').trim();
    if (sel && !(panel && panel.contains(getSelection().anchorNode))) lastSelection = sel;
  });

  const style = el('style');
  style.textContent = `
    .ad-btn { position: fixed; left: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 2147482900; padding: 8px 14px; border-radius: 999px; border: 0; cursor: pointer; font: 600 13px system-ui, sans-serif; color: #fff; background: linear-gradient(135deg, #0ea5e9, #6366f1); box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .ad-panel { position: fixed; left: 16px; bottom: calc(60px + env(safe-area-inset-bottom, 0px)); z-index: 2147482900; width: min(380px, calc(100vw - 32px)); max-height: min(560px, 70vh); display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 14px; background: var(--ad-bg, #fff); color: var(--ad-fg, #1b1630); border: 1px solid rgba(127,127,127,.3); box-shadow: 0 8px 30px rgba(0,0,0,.3); font: 13px system-ui, sans-serif; box-sizing: border-box; }
    .ad-panel[hidden] { display: none; }
    .ad-head { display: flex; align-items: center; gap: 8px; }
    .ad-head strong { flex: 1; }
    .ad-head a { color: inherit; opacity: .8; }
    .ad-panel button { font: inherit; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; padding: 4px 9px; }
    .ad-ctx { font-size: 12px; opacity: .75; word-break: break-word; }
    .ad-log { flex: 1; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .ad-msg { white-space: pre-wrap; padding: 6px 9px; border-radius: 10px; max-width: 92%; word-break: break-word; }
    .ad-msg.user { align-self: flex-end; background: rgba(99,102,241,.18); }
    .ad-msg.assistant { align-self: flex-start; background: rgba(127,127,127,.12); }
    .ad-msg.error { color: #b91c1c; }
    .ad-form { display: flex; gap: 6px; align-items: flex-end; }
    .ad-form textarea { flex: 1; resize: none; min-height: 36px; max-height: 120px; font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; box-sizing: border-box; }
    .ad-form button:disabled { opacity: .5; cursor: default; }
    .ad-note { font-size: 12px; opacity: .8; }
    @media (prefers-color-scheme: dark) { .ad-panel { --ad-bg: #1e1b2e; --ad-fg: #ece9f7; } }
    :root[data-theme="dark"] .ad-panel { --ad-bg: #1e1b2e; --ad-fg: #ece9f7; }
    :root[data-theme="light"] .ad-panel { --ad-bg: #fff; --ad-fg: #1b1630; }
  `;

  const btn = el('button', { className: 'ad-btn', type: 'button', hidden: true, textContent: 'Assistant' });
  btn.setAttribute('aria-expanded', 'false');
  const panel = el('div', { className: 'ad-panel', hidden: true });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Assistant');
  panel.innerHTML = `
    <div class="ad-head"><strong>Assistant</strong><a href="${pageUrl}">Full page</a><button type="button" class="ad-x" aria-label="Close">×</button></div>
    <div class="ad-ctx"></div>
    <div class="ad-log" aria-live="polite"></div>
    <div class="ad-note" hidden></div>
    <form class="ad-form">
      <textarea rows="1" placeholder="Ask about this page, or /remember something"></textarea>
      <button type="button" class="ad-mic" hidden title="Speak instead of typing">🎙</button>
      <button type="submit" class="ad-send">Send</button>
    </form>`;
  const q = (s) => panel.querySelector(s);
  const log = q('.ad-log');
  const ta = q('textarea');
  const sendBtn = q('.ad-send');
  const note = q('.ad-note');

  const bubble = (role, text) => {
    const div = el('div', { className: `ad-msg ${role}`, textContent: text });
    log.append(div);
    log.scrollTop = log.scrollHeight;
    return div;
  };
  const setNote = (text) => { note.textContent = text || ''; note.hidden = !text; };
  const contextLabel = () => {
    const c = gatherContext({ pathname: location.pathname, hash: location.hash, title: document.title });
    const label = document.title ? `On: ${document.title}` : `On: ${c.page}`;
    q('.ad-ctx').textContent = lastSelection ? `${label}, with selected text` : label;
  };

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    contextLabel();
    ta.focus();
  }
  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.focus();
  }
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  q('.ad-x').addEventListener('click', close);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); q('form').requestSubmit(); }
  });

  // Speech to text, where the browser has it (Chrome, Edge, Safari). The transcript is added after what is typed.
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Speech) {
    const mic = q('.ad-mic');
    mic.hidden = false;
    let rec = null;
    mic.addEventListener('click', () => {
      if (rec) return rec.stop();
      rec = new Speech();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) ta.value = `${ta.value.trim()} ${e.results[i][0].transcript}`.trim();
        }
      };
      rec.onerror = (e) => setNote(`Speech: ${e.error || 'error'}`);
      rec.onend = () => { rec = null; mic.textContent = '🎙'; };
      rec.start();
      mic.textContent = '■';
    });
  }

  q('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    sendBtn.disabled = true;
    setNote('');
    bubble('user', text);
    const pending = bubble('assistant', 'Thinking…');
    pending.classList.add('pending');
    const context = gatherContext({ pathname: location.pathname, hash: location.hash, title: document.title, selection: lastSelection });
    try {
      const res = await fetch(api('assistant/message'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, context }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      pending.textContent = body.reply;
      pending.classList.remove('pending');
    } catch (err) {
      pending.textContent = `Could not send: ${err.message}`;
      pending.classList.add('error');
    } finally {
      sendBtn.disabled = false;
      ta.focus();
    }
  });

  (async () => {
    try {
      const info = await fetch(api('assistant'), { credentials: 'same-origin' });
      if (!info.ok) return; // not the owner, or the assistant is off here: no button
      const history = await (await fetch(api('assistant/history'), { credentials: 'same-origin' })).json();
      for (const m of history.messages || []) bubble(m.role === 'user' ? 'user' : 'assistant', m.content);
      if (!(history.messages || []).length) bubble('assistant', 'Hi. Ask about this page, or anything else. The conversation is the same as on the Assistant page.');
      document.head.append(style);
      document.body.append(btn, panel);
      btn.hidden = false;
    } catch { /* offline or no assistant: stay hidden */ }
  })();
})();
