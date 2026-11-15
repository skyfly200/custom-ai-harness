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
// dot on it shows that the assistant is waiting for you to allow or decline a tool call; a blue dot, that a reply came
// in while the panel was shut. Alt+A opens and closes the panel from anywhere but a text field.
//
// Replies stream in as the model writes them (POST api/assistant/stream, read by ui/assistant-stream.js) and are
// drawn as Markdown with ui/markdown.js, which escapes every piece of model text before it adds a tag; links open only
// http(s) and mailto. While a reply streams, the send button is a Stop button: it ends the reply where it is, and the
// server keeps the words written so far.
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

/** Alt+A (by key position, so a Mac's Option+A counts too), outside text fields, toggles the panel. */
function isShortcut(e) {
  if (!e || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.code !== 'KeyA' && String(e.key || '').toLowerCase() !== 'a') return false;
  const t = e.target;
  const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  return !editable;
}
const SHORTCUT_LABEL = 'Alt+A';

/** True when the newest assistant message is later than the time the panel was last seen open. */
function hasUnread(messages, seenAt) {
  const last = [...(messages || [])].reverse().find((m) => m && m.role !== 'user');
  return Boolean(last && Number(last.at) > (Number(seenAt) || 0));
}

if (typeof module !== 'undefined') {
  // reading the stream lives in ui/assistant-stream.js, shared with the Assistant page
  const { parseEvents } = require('./assistant-stream.js');
  module.exports = { gatherContext, liftFor, ICONS, GAP, isShortcut, parseEvents, hasUnread, SHORTCUT_LABEL };
}

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
    .ad-btn .ad-dot.unread { background: var(--glow-d, #06b6d4); }
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
    .ad-msg.stopped::after { content: 'Stopped'; display: block; margin-top: 4px; font-size: 11px; opacity: .65; }
    .ad-msg.md { white-space: normal; }
    .ad-msg.md > :first-child { margin-top: 0; } .ad-msg.md > :last-child { margin-bottom: 0; }
    .ad-msg.md p, .ad-msg.md ul, .ad-msg.md ol, .ad-msg.md blockquote, .ad-msg.md .code, .ad-msg.md .table-scroll { margin: 0 0 6px; }
    .ad-msg.md ul, .ad-msg.md ol { padding-left: 20px; }
    .ad-msg.md h1, .ad-msg.md h2, .ad-msg.md h3, .ad-msg.md h4 { font-size: 14px; margin: 8px 0 4px; }
    .ad-msg.md blockquote { padding-left: 8px; border-left: 3px solid rgba(127,127,127,.4); opacity: .85; }
    .ad-msg.md a { color: inherit; text-decoration: underline; }
    .ad-msg.md code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ad-msg.md :not(pre) > code { padding: 0 4px; border-radius: 4px; background: rgba(127,127,127,.18); }
    .ad-msg.md .code { border-radius: 8px; overflow: hidden; border: 1px solid rgba(127,127,127,.3); }
    .ad-msg.md .code-head { display: flex; justify-content: space-between; align-items: center; padding: 2px 6px; font-size: 11px; opacity: .8; }
    .ad-msg.md .code-head button { padding: 1px 6px; font-size: 11px; }
    .ad-msg.md pre { margin: 0; padding: 6px 8px; overflow-x: auto; white-space: pre; background: rgba(127,127,127,.1); }
    .ad-msg.md .table-scroll { overflow-x: auto; }
    .ad-msg.md table { border-collapse: collapse; font-size: 12px; }
    .ad-msg.md th, .ad-msg.md td { padding: 3px 6px; border: 1px solid rgba(127,127,127,.35); }
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

  const btn = el('button', { className: 'ad-btn', type: 'button', hidden: true, title: `Assistant (${SHORTCUT_LABEL})` });
  btn.setAttribute('aria-keyshortcuts', 'Alt+A');
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

  // Markdown for the assistant's words: markdown.js is on the chat page already; elsewhere it is loaded once, and the
  // replies already shown are redrawn when it arrives. Until then (or if it fails) replies are plain text.
  let md = window.Markdown || null;
  const words = new WeakMap(); // bubble -> its text, to redraw it
  function draw(div, text) {
    words.set(div, text);
    const asMd = md && div.classList.contains('assistant') && !div.classList.contains('error') && !div.classList.contains('pending');
    div.classList.toggle('md', Boolean(asMd));
    if (asMd) div.innerHTML = md.render(text); // markdown.js escapes all of the text before it adds any tag
    else div.textContent = text;
  }
  if (!md) {
    const s = el('script', { src: new URL('markdown.js', script.src).href, async: true });
    s.onload = () => { md = window.Markdown || null; for (const div of log.querySelectorAll('.ad-msg.assistant')) if (words.has(div)) draw(div, words.get(div)); };
    document.head.append(s);
  }
  // The stream reader (ui/assistant-stream.js), loaded once; a message waits for it.
  const streamLib = window.AssistantStream ? Promise.resolve(window.AssistantStream) : new Promise((resolve, reject) => {
    const s = el('script', { src: new URL('assistant-stream.js', script.src).href, async: true });
    s.onload = () => (window.AssistantStream ? resolve(window.AssistantStream) : reject(new Error('the stream reader did not load')));
    s.onerror = () => reject(new Error('the stream reader did not load'));
    document.head.append(s);
  });
  streamLib.catch(() => {}); // reported when a message is sent
  const stuckToBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const bubble = (role, text) => {
    const div = el('div', { className: `ad-msg ${role}` });
    draw(div, text);
    log.append(div);
    log.scrollTop = log.scrollHeight;
    return div;
  };
  // the Copy button on a code block in a reply
  log.addEventListener('click', async (e) => {
    const b = e.target.closest('.copy-code');
    if (!b) return;
    const code = b.closest('.code')?.querySelector('pre')?.textContent || '';
    try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; } catch { b.textContent = 'Could not copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  const setNote = (text) => { note.textContent = text || ''; note.hidden = !text; };
  const contextLabel = () => {
    const c = gatherContext({ pathname: location.pathname, hash: location.hash, title: document.title });
    const label = document.title ? `On: ${document.title}` : `On: ${c.page}`;
    q('.ad-ctx').textContent = lastSelection ? `${label}, with selected text` : label;
  };

  // A tool call waiting for /yes or /no: the question with Allow and Decline in the panel, and a dot on the button.
  // A reply that came in while the panel was shut: a blue dot until the panel is next opened. "Seen" is kept per
  // browser, so opening the panel in one tab clears the dot in the others.
  const SEEN_KEY = 'assistantDock.seenAt';
  let waiting = null;
  let unread = false;
  let shown = -1;       // how many saved messages the log is drawing
  let sending = false;  // a message is on its way: leave the log alone
  // A browser that has never opened the panel starts as having seen everything, so old replies don't light the dot.
  const seenAt = () => {
    try {
      const v = localStorage.getItem(SEEN_KEY);
      if (v === null) { localStorage.setItem(SEEN_KEY, String(Date.now())); return Date.now(); }
      return Number(v) || 0;
    } catch { return Date.now(); }
  };
  const markSeen = () => { unread = false; try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {} syncLabel(); };
  function setUnread(on) { unread = Boolean(on) && panel.hidden; syncLabel(); }
  function setPending(question) {
    waiting = question || null;
    ask.hidden = !waiting;
    ask.querySelector('p').textContent = waiting || '';
    syncLabel();
    if (waiting) log.scrollTop = log.scrollHeight;
  }
  function syncLabel() {
    const open = !panel.hidden;
    dot.hidden = !(waiting || unread);
    dot.classList.toggle('unread', !waiting && unread);
    btn.title = `${waiting ? 'Assistant: waiting for your approval' : unread ? 'Assistant: new reply' : 'Assistant'} (${SHORTCUT_LABEL})`;
    srLabel.textContent = open ? 'Close the assistant' : waiting ? 'Open the assistant (waiting for your approval)' : unread ? 'Open the assistant (new reply)' : 'Open the assistant';
    btn.innerHTML = ''; // swap the icon, keep the label and the dot
    btn.insertAdjacentHTML('afterbegin', open ? ICONS.close : ICONS.assistant);
    btn.append(srLabel, dot);
  }

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    markSeen();
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
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
    else if (isShortcut(e) && !btn.hidden) { e.preventDefault(); panel.hidden ? open() : close(); }
  });

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

  // Sends a message and streams the reply into its bubble. Falls back to the plain route on a server without
  // the stream route. The final text from the server replaces what streamed, since a step that ended in a tool
  // call can leave text the answer does not keep. Stop aborts the request: the bubble keeps what streamed.
  async function post(route, text, context, signal) {
    return fetch(api(route), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context }),
      signal,
    });
  }
  let controller = null; // the reply being streamed, for the Stop button
  function setSendButton(streaming) {
    sendBtn.innerHTML = streaming ? ICONS.stop : ICONS.send;
    const label = streaming ? 'Stop the reply' : 'Send';
    sendBtn.title = label;
    sendBtn.setAttribute('aria-label', label);
  }
  async function send(text) {
    sending = true;
    controller = new AbortController();
    setSendButton(true);
    for (const b of ask.querySelectorAll('button')) b.disabled = true;
    setNote('');
    bubble('user', text);
    const pending = bubble('assistant', 'Thinking…');
    pending.classList.add('pending');
    draw(pending, 'Thinking…');
    const context = gatherContext({ pathname: location.pathname, hash: location.hash, title: document.title, selection: lastSelection });
    let streamed = '';
    let queued = false;
    let finished = false; // once the final text is in, a late frame must not paint the streamed text over it
    const paint = () => {
      queued = false;
      if (finished) return;
      const follow = stuckToBottom();
      pending.classList.remove('pending');
      draw(pending, streamed || 'Thinking…');
      if (!streamed) pending.classList.add('pending');
      if (follow) log.scrollTop = log.scrollHeight;
    };
    let lib = null;
    try {
      lib = await streamLib;
      const { signal } = controller;
      let res = await post('assistant/stream', text, context, signal);
      if (res.status === 404) res = await post('assistant/message', text, context, signal);
      const body = await lib.readReply(res, {
        onText: (t) => { streamed = t; if (!queued) { queued = true; requestAnimationFrame(paint); } },
      });
      finished = true;
      pending.classList.remove('pending');
      draw(pending, String(body.reply ?? ''));
      log.scrollTop = log.scrollHeight;
      setPending(body.pending);
      if (panel.hidden) setUnread(true); else markSeen();
    } catch (err) {
      finished = true;
      pending.classList.remove('pending');
      if (lib && lib.isAbort(err)) {
        if (streamed) { draw(pending, streamed); pending.classList.add('stopped'); } else pending.remove();
        setPending(null); // a stopped /yes or /no is answered; the history has the rest
      } else {
        pending.classList.add('error');
        draw(pending, `Could not send: ${err.message}`);
      }
    } finally {
      sending = false;
      controller = null;
      shown = -1; // the next look at the history redraws it from the server's copy
      setSendButton(false);
      for (const b of ask.querySelectorAll('button')) b.disabled = false;
      if (!panel.hidden) ta.focus();
    }
  }

  // While a reply streams, the send button stops it; Enter waits, so a half-typed next message is not lost.
  sendBtn.addEventListener('click', (event) => {
    if (!controller) return;
    event.preventDefault();
    controller.abort();
  });
  q('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (sending) return;
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
      document.head.append(style);
      document.body.append(btn, panel);
      await loadHistory();
      placeButton();
      btn.hidden = false;
    } catch { /* offline or no assistant: stay hidden */ }
  })();

  // The conversation, drawn fresh. Run on load, and again when the tab comes back into view, so a reply sent from
  // the Assistant page or another tab shows here (with the blue dot while the panel is shut).
  async function loadHistory() {
    const history = await (await fetch(api('assistant/history'), { credentials: 'same-origin' })).json();
    const messages = history.messages || [];
    if (messages.length !== shown) {
      shown = messages.length;
      log.replaceChildren();
      for (const m of messages) bubble(m.role === 'user' ? 'user' : 'assistant', m.content).classList.toggle('stopped', Boolean(m.stopped));
      if (!messages.length) bubble('assistant', 'Hi. Ask about this page, or anything else. The conversation is the same as on the Assistant page.');
    }
    setPending(history.pending);
    if (panel.hidden) setUnread(hasUnread(messages, seenAt()));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !btn.hidden && !sending) loadHistory().catch(() => {});
  });
  addEventListener('storage', (e) => { if (e.key === SEEN_KEY && unread) setUnread(false); });
})();
