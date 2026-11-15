// The assistant, one tap away on every page: a small "Assistant" button in the bottom-left corner that opens a
// panel. It talks to the same conversation as the Assistant page (utils/assistant.js), so a message sent here
// shows up there too. Each message carries the page you are on (and any text you had selected) so the assistant
// can answer about what is in front of you. The page context is shown in the panel, and only the page's path,
// title and selection are sent; the server caps and sanitises them (utils/assistant.js pageContext).
//
// Added by nav.js to every page that has the site navigation, except the Assistant page itself. Hidden unless the
// signed-in person may use the assistant (the owner, or an admin), so other people never see it.
//
// The button is a round orb with an icon (a chat bubble with a spark) that turns into a close icon while the panel is
// open. It sits above a bar that covers the bottom-left corner (the chat composer, the chat sidebar's footer), and a
// dot on it shows that the assistant is waiting for you to allow or decline a tool call.
'use strict';

/** What to send with a message: the page path (with the hash, so the chat id counts), its title and the selection. */
function gatherContext({ pathname = '', hash = '', title = '', selection = '' } = {}) {
  return { page: `${pathname}${hash}`, title: String(title || ''), selection: String(selection || '').trim() };
}

// The icons, in the same line style as the chat page's (24-unit box, 2-unit round strokes, currentColor)
const ICONS = {
  assistant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><path d="M12 7.6l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" fill="currentColor" stroke-width="1.2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M17 7 7 17M7 7l10 10"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>',
};

const GAP = 16; // the button's distance from the corner, and the space it keeps above a bar

/**
 * How far from the bottom of the window the button sits, so it stays clear of bars in the bottom-left corner.
 * `rects` are the bounding boxes of elements that may cover the corner; one counts when it is visible, spans the
 * button's column (`x`) and reaches the bottom of the window. Returns GAP when nothing is in the way.
 */
function liftFor(rects, viewportHeight, x = GAP + 22) {
  let lift = GAP;
  for (const r of rects || []) {
    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
    if (r.left > x || r.right < x) continue;
    if (r.bottom < viewportHeight - 2 || r.top >= viewportHeight) continue;
    lift = Math.max(lift, Math.round(viewportHeight - r.top + GAP / 2));
  }
  return Math.min(lift, Math.round(viewportHeight / 2)); // never push it off the top half
}

if (typeof module !== 'undefined') module.exports = { gatherContext, liftFor, ICONS, GAP };

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
    .ad-btn { --ad-lift: ${GAP}px; position: fixed; left: ${GAP}px; bottom: calc(var(--ad-lift) + env(safe-area-inset-bottom, 0px)); z-index: 2147482900; width: 48px; height: 48px; padding: 0; display: grid; place-items: center; border-radius: 50%; border: 0; cursor: pointer; color: #fff;
      background: radial-gradient(circle at 32% 28%, rgba(255,255,255,.55) 0 7%, var(--glow-a, #f59e0b) 24%, var(--glow-b, #ec4899) 55%, var(--glow-c, #7c5cff) 85%);
      box-shadow: 0 4px 14px rgba(0,0,0,.28), 0 0 18px -4px var(--glow-b, #ec4899); transition: transform .15s ease, box-shadow .15s ease, bottom .15s ease; }
    .ad-btn svg { width: 24px; height: 24px; filter: drop-shadow(0 1px 1px rgba(0,0,0,.3)); }
    .ad-btn:hover { transform: scale(1.06); box-shadow: 0 6px 18px rgba(0,0,0,.3), 0 0 24px -4px var(--glow-b, #ec4899); }
    .ad-btn:focus-visible { outline: 3px solid var(--glow-d, #06b6d4); outline-offset: 3px; }
    .ad-btn .ad-dot { position: absolute; top: 1px; right: 1px; width: 12px; height: 12px; border-radius: 50%; background: #f59e0b; border: 2px solid #fff; box-sizing: border-box; }
    .ad-btn .ad-dot[hidden] { display: none; }
    .ad-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    @media (prefers-reduced-motion: reduce) { .ad-btn { transition: none; } .ad-btn:hover { transform: none; } }
    .ad-panel { position: fixed; left: ${GAP}px; bottom: calc(var(--ad-lift, ${GAP}px) + 60px + env(safe-area-inset-bottom, 0px)); z-index: 2147482900; width: min(380px, calc(100vw - ${GAP * 2}px)); max-height: min(560px, 70vh); display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 14px; background: var(--ad-bg, #fff); color: var(--ad-fg, #1b1630); border: 1px solid rgba(127,127,127,.3); box-shadow: 0 8px 30px rgba(0,0,0,.3); font: 13px system-ui, sans-serif; box-sizing: border-box; }
    .ad-panel[hidden] { display: none; }
    .ad-head { display: flex; align-items: center; gap: 8px; }
    .ad-head strong { flex: 1; }
    .ad-head a { color: inherit; opacity: .8; }
    .ad-panel button { font: inherit; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; padding: 4px 9px; }
    .ad-panel button.ad-icon { display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; }
    .ad-panel button.ad-icon svg { width: 17px; height: 17px; }
    .ad-head button.ad-icon { width: 28px; height: 28px; border-color: transparent; }
    .ad-ctx { font-size: 12px; opacity: .75; word-break: break-word; }
    .ad-log { flex: 1; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .ad-msg { white-space: pre-wrap; padding: 6px 9px; border-radius: 10px; max-width: 92%; word-break: break-word; }
    .ad-msg.user { align-self: flex-end; background: rgba(99,102,241,.18); }
    .ad-msg.assistant { align-self: flex-start; background: rgba(127,127,127,.12); }
    .ad-msg.error { color: #b91c1c; }
    .ad-ask { display: flex; flex-direction: column; gap: 6px; padding: 8px 9px; border-radius: 10px; border: 1px solid rgba(245,158,11,.6); background: rgba(245,158,11,.12); }
    .ad-ask[hidden] { display: none; }
    .ad-ask p { margin: 0; word-break: break-word; }
    .ad-ask div { display: flex; gap: 6px; }
    .ad-ask .ad-allow { background: #16a34a; border-color: #16a34a; color: #fff; }
    .ad-form { display: flex; gap: 6px; align-items: flex-end; }
    .ad-form textarea { flex: 1; resize: none; min-height: 36px; max-height: 120px; font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; box-sizing: border-box; }
    .ad-form button:disabled { opacity: .5; cursor: default; }
    .ad-note { font-size: 12px; opacity: .8; }
    @media (prefers-color-scheme: dark) { .ad-panel { --ad-bg: #1e1b2e; --ad-fg: #ece9f7; } }
    :root[data-theme="dark"] .ad-panel { --ad-bg: #1e1b2e; --ad-fg: #ece9f7; }
    :root[data-theme="light"] .ad-panel { --ad-bg: #fff; --ad-fg: #1b1630; }
  `;

  const btn = el('button', { className: 'ad-btn', type: 'button', hidden: true, title: 'Assistant' });
  btn.innerHTML = `${ICONS.assistant}<span class="ad-sr">Open the assistant</span><span class="ad-dot" hidden></span>`;
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'ad-panel');
  const panel = el('div', { className: 'ad-panel', id: 'ad-panel', hidden: true });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Assistant');
  panel.innerHTML = `
    <div class="ad-head"><strong>Assistant</strong><a href="${pageUrl}">Full page</a><button type="button" class="ad-x ad-icon" aria-label="Close" title="Close">${ICONS.close}</button></div>
    <div class="ad-ctx"></div>
    <div class="ad-log" aria-live="polite"></div>
    <div class="ad-ask" role="group" aria-label="Approval needed" hidden>
      <p></p>
      <div><button type="button" class="ad-allow">Allow</button><button type="button" class="ad-decline">Decline</button></div>
    </div>
    <div class="ad-note" hidden></div>
    <form class="ad-form">
      <textarea rows="1" placeholder="Ask about this page, or /remember something" aria-label="Message"></textarea>
      <button type="button" class="ad-mic ad-icon" hidden title="Speak instead of typing" aria-label="Speak instead of typing">${ICONS.mic}</button>
      <button type="submit" class="ad-send ad-icon" title="Send" aria-label="Send">${ICONS.send}</button>
    </form>`;
  const q = (s) => panel.querySelector(s);
  const log = q('.ad-log');
  const ta = q('textarea');
  const sendBtn = q('.ad-send');
  const note = q('.ad-note');
  const ask = q('.ad-ask');
  const dot = btn.querySelector('.ad-dot');
  const srLabel = btn.querySelector('.ad-sr');

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

  // A tool call waiting for /yes or /no: the question with Allow and Decline in the panel, and a dot on the button.
  let waiting = null;
  function setPending(question) {
    waiting = question || null;
    ask.hidden = !waiting;
    ask.querySelector('p').textContent = waiting || '';
    dot.hidden = !waiting;
    btn.title = waiting ? 'Assistant: waiting for your approval' : 'Assistant';
    syncLabel();
    if (waiting) log.scrollTop = log.scrollHeight;
  }
  function syncLabel() {
    const open = !panel.hidden;
    srLabel.textContent = open ? 'Close the assistant' : waiting ? 'Open the assistant (waiting for your approval)' : 'Open the assistant';
    btn.innerHTML = ''; // swap the icon, keep the label and the dot
    btn.insertAdjacentHTML('afterbegin', open ? ICONS.close : ICONS.assistant);
    btn.append(srLabel, dot);
  }

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    syncLabel();
    contextLabel();
    ta.focus();
  }
  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    syncLabel();
    btn.focus();
  }
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  q('.ad-x').addEventListener('click', close);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); q('form').requestSubmit(); }
  });

  // Keep the button clear of bars in the bottom-left corner: the chat composer, the chat sidebar's footer.
  const BARS = '.compose, .side-foot, [data-assistant-avoid]';
  let liftQueued = false;
  function placeButton() {
    liftQueued = false;
    const rects = [...document.querySelectorAll(BARS)].filter((n) => !panel.contains(n)).map((n) => n.getBoundingClientRect());
    btn.style.setProperty('--ad-lift', `${liftFor(rects, innerHeight)}px`);
    panel.style.setProperty('--ad-lift', btn.style.getPropertyValue('--ad-lift'));
  }
  const queuePlace = () => { if (!liftQueued) { liftQueued = true; requestAnimationFrame(placeButton); } };
  addEventListener('resize', queuePlace);
  document.addEventListener('transitionend', queuePlace, true); // e.g. the chat sidebar sliding open or shut
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(queuePlace);
    for (const n of document.querySelectorAll(BARS)) ro.observe(n);
  }

  // Speech to text, where the browser has it (Chrome, Edge, Safari). The transcript is added after what is typed.
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Speech) {
    const mic = q('.ad-mic');
    mic.hidden = false;
    let rec = null;
    const micState = (on) => {
      mic.innerHTML = on ? ICONS.stop : ICONS.mic;
      const label = on ? 'Stop listening' : 'Speak instead of typing';
      mic.title = label;
      mic.setAttribute('aria-label', label);
    };
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
      rec.onend = () => { rec = null; micState(false); };
      rec.start();
      micState(true);
    });
  }

  async function send(text) {
    sendBtn.disabled = true;
    for (const b of ask.querySelectorAll('button')) b.disabled = true;
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
      setPending(body.pending);
    } catch (err) {
      pending.textContent = `Could not send: ${err.message}`;
      pending.classList.add('error');
    } finally {
      sendBtn.disabled = false;
      for (const b of ask.querySelectorAll('button')) b.disabled = false;
      ta.focus();
    }
  }

  q('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    send(text);
  });
  q('.ad-allow').addEventListener('click', () => send('/yes'));
  q('.ad-decline').addEventListener('click', () => send('/no'));

  (async () => {
    try {
      const info = await fetch(api('assistant'), { credentials: 'same-origin' });
      if (!info.ok) return; // not the owner, or the assistant is off here: no button
      const history = await (await fetch(api('assistant/history'), { credentials: 'same-origin' })).json();
      for (const m of history.messages || []) bubble(m.role === 'user' ? 'user' : 'assistant', m.content);
      if (!(history.messages || []).length) bubble('assistant', 'Hi. Ask about this page, or anything else. The conversation is the same as on the Assistant page.');
      document.head.append(style);
      document.body.append(btn, panel);
      setPending(history.pending);
      placeButton();
      btn.hidden = false;
    } catch { /* offline or no assistant: stay hidden */ }
  })();
})();
