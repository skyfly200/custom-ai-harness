// Harness chat page. Talks to the Interceptor like any other OpenAI client
// (POST /v1/chat/completions) and follows its live feed (/ui/api/live) to show
// what happens to each request. Chats live in this browser's localStorage.
'use strict';

const $ = (id) => document.getElementById(id);
const { render, toSpeech, escape: esc } = window.Markdown;

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};
const setIcon = (id, name) => { $(id).innerHTML = ICONS[name]; };
setIcon('copyChat', 'copy'); setIcon('exportChat', 'download'); setIcon('toggleOptions', 'sliders');
setIcon('toggleActivity', 'pulse'); setIcon('attach', 'clip'); setIcon('mic', 'mic');
setIcon('toggleSide', 'menu'); setIcon('closeActivity', 'close');

// ---------------------------------------------------------------------------
// Storage: an index of chats plus one key per chat, so streaming a reply only
// rewrites that chat.
// ---------------------------------------------------------------------------
const INDEX_KEY = 'harness-chats';
const CHAT_KEY = (id) => `harness-chat:${id}`;
const PREF_KEY = 'harness-chat-prefs';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (err) {
      toast(err.name === 'QuotaExceededError' ? 'Browser storage is full. Delete old chats or large images to keep saving.' : `Could not save: ${err.message}`);
      return false;
    }
  },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

let index = store.get(INDEX_KEY, []);   // [{id, title, updated, count}]
const cache = new Map();                 // id -> chat
let chat = null;                         // the open chat
const running = new Map();               // chat id -> { controller, reply }

function newChatObject() {
  return { id: uid(), title: '', created: Date.now(), updated: Date.now(), system: '', notes: '', messages: [] };
}

function loadChat(id) {
  if (cache.has(id)) return cache.get(id);
  const c = store.get(CHAT_KEY(id), null);
  if (c) cache.set(id, c);
  return c;
}

function saveChat(c, { touch = true } = {}) {
  if (touch) c.updated = Date.now();
  cache.set(c.id, c);
  // an empty chat isn't listed until something is in it
  if (!c.messages.length && !c.system && !c.notes) return;
  store.set(CHAT_KEY(c.id), c);
  const entry = { id: c.id, title: chatTitle(c), updated: c.updated, count: c.messages.length };
  const i = index.findIndex(e => e.id === c.id);
  if (i >= 0) index[i] = entry; else index.push(entry);
  index.sort((a, b) => b.updated - a.updated);
  store.set(INDEX_KEY, index);
}

function deleteChat(id) {
  running.get(id)?.controller.abort();
  index = index.filter(e => e.id !== id);
  cache.delete(id);
  store.remove(CHAT_KEY(id));
  store.set(INDEX_KEY, index);
  if (chat?.id === id) openChat(index[0]?.id);
  else drawList();
}

function chatTitle(c) {
  if (c.title) return c.title;
  const first = c.messages.find(m => m.role === 'user');
  if (!first) return 'New chat';
  const t = first.content.replace(/\s+/g, ' ').trim() || (first.attachments?.[0]?.name ?? 'New chat');
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

// The page before this one kept a single chat under 'harness-chat'
(function migrate() {
  const old = store.get('harness-chat', null);
  if (!Array.isArray(old) || !old.length) return;
  const c = newChatObject();
  c.messages = old.map(m => ({ id: uid(), ...m }));
  try { c.system = localStorage.getItem('harness-chat-system') || ''; } catch {}
  saveChat(c);
  store.remove('harness-chat');
})();

// ---------------------------------------------------------------------------
// Preferences (model, voice) shared by every chat
// ---------------------------------------------------------------------------
const PREF_FIELDS = ['model', 'maxTokens', 'temperature', 'stream', 'sttLang', 'autoSend', 'ttsEngine', 'voice', 'serverVoice', 'rate', 'pitch', 'volume', 'autoSpeak', 'handsFree'];
const prefs = store.get(PREF_KEY, {});
// carry over the old page's toolbar
for (const id of ['model', 'maxTokens', 'temperature']) {
  try { const v = localStorage.getItem(`harness-chat-${id}`); if (v !== null && prefs[id] === undefined) prefs[id] = v; } catch {}
}
function applyPrefs() {
  for (const id of PREF_FIELDS) {
    if (prefs[id] === undefined) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!prefs[id]; else el.value = prefs[id];
  }
  drawSliders();
}
function drawSliders() {
  $('rateOut').textContent = `${Number($('rate').value).toFixed(1)}×`;
  $('pitchOut').textContent = Number($('pitch').value).toFixed(1);
  $('volumeOut').textContent = `${Math.round($('volume').value * 100)}%`;
}
for (const id of PREF_FIELDS) {
  $(id).addEventListener('change', () => {
    const el = $(id);
    prefs[id] = el.type === 'checkbox' ? el.checked : el.value;
    store.set(PREF_KEY, prefs);
    if (id === 'handsFree' && el.checked) { $('autoSend').checked = $('autoSpeak').checked = true; prefs.autoSend = prefs.autoSpeak = true; store.set(PREF_KEY, prefs); }
    if (id === 'autoSpeak' && !el.checked) speech.stop();
    if (id === 'ttsEngine') { speech.stop(); drawEngine(); }
    drawHint();
  });
}
for (const id of ['rate', 'pitch', 'volume']) $(id).addEventListener('input', drawSliders);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http:// from another machine has no clipboard API
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
}

function flashCopied(btn) {
  const before = btn.innerHTML;
  btn.innerHTML = btn.classList.contains('copy-code') ? 'Copied' : ICONS.check;
  setTimeout(() => { btn.innerHTML = before; }, 1200);
}

const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const approxTokens = (chars) => Math.round(chars / 4);
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Chats sidebar
// ---------------------------------------------------------------------------
function drawList() {
  const q = $('search').value.trim().toLowerCase();
  const rows = index.filter(e => !q || e.title.toLowerCase().includes(q) ||
    (loadChat(e.id)?.messages || []).some(m => String(m.content).toLowerCase().includes(q)));
  $('chatList').innerHTML = rows.map(e => `<li data-id="${e.id}" class="${e.id === chat?.id ? 'active' : ''}" title="${esc(e.title)}">
      ${running.has(e.id) ? '<span class="busy" title="Replying"></span>' : ''}
      <div class="ct"><b>${esc(e.title)}</b><span>${ago(e.updated)} · ${e.count} msg${e.count === 1 ? '' : 's'}</span></div>
      <button class="del" data-del="${e.id}" title="Delete chat" aria-label="Delete chat">${ICONS.trash}</button></li>`).join('')
    || `<li class="muted small">${q ? 'No chats match.' : 'No saved chats yet.'}</li>`;
}

$('chatList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const entry = index.find(x => x.id === del.dataset.del);
    if (confirm(`Delete “${entry?.title || 'this chat'}”?`)) deleteChat(del.dataset.del);
    return;
  }
  const li = e.target.closest('li[data-id]');
  if (li) { openChat(li.dataset.id); $('app').classList.remove('side-open'); }
});
$('search').addEventListener('input', drawList);

function openChat(id) {
  if (chat && chat.id !== id) saveDraft();
  chat = (id && loadChat(id)) || newChatObject();
  cache.set(chat.id, chat);
  $('title').value = chat.title;
  $('title').placeholder = chatTitle(chat);
  $('system').value = chat.system || '';
  $('notes').value = chat.notes || '';
  $('input').value = chat.draft || '';
  pending = chat.pendingAttachments || [];
  drawChips(); autoGrow(); drawContextSize();
  drawList();
  drawLog();
  busy(running.has(chat.id));
  try { localStorage.setItem('harness-chat-open', chat.id); } catch {}
  $('input').focus();
}

function saveDraft() {
  if (!chat) return;
  chat.draft = $('input').value;
  chat.pendingAttachments = pending;
  if (chat.messages.length) saveChat(chat, { touch: false });
}

function stepChat(dir) {
  if (!index.length) return;
  const i = index.findIndex(e => e.id === chat?.id);
  const next = index[Math.max(0, Math.min(index.length - 1, (i < 0 ? -1 : i) + dir))];
  if (next) openChat(next.id);
}

$('newChat').addEventListener('click', () => { openChat(null); $('app').classList.remove('side-open'); });
$('toggleSide').addEventListener('click', () => $('app').classList.toggle('side-open'));
$('title').addEventListener('change', () => { chat.title = $('title').value.trim(); saveChat(chat, { touch: false }); drawList(); });
$('system').addEventListener('change', () => { chat.system = $('system').value; saveChat(chat); drawList(); drawContextSize(); });
$('notes').addEventListener('change', () => { chat.notes = $('notes').value; saveChat(chat); drawList(); drawContextSize(); });
$('system').addEventListener('input', drawContextSize);
$('notes').addEventListener('input', drawContextSize);

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
function emptyState() {
  return `<div class="empty"><h2>Ask anything</h2>
    <p>Messages go through the Interceptor like any other client, so the Router picks the model unless you name one in Options.
    Each reply shows, live, where it went and why.</p>
    <p class="small">Attach files with the paperclip or by dropping them here, dictate with the mic, and add standing context under Options.</p></div>`;
}

function attachmentsHtml(list) {
  if (!list?.length) return '';
  return `<div class="attach-list">${list.map(a => a.kind === 'image'
    ? `<img src="${esc(a.dataUrl)}" alt="${esc(a.name)}" title="${esc(a.name)}">`
    : `<span class="chip"><span>📄 ${esc(a.name)}</span></span>`).join('')}</div>`;
}

// Why the Router picked this model, in a few words
function routeWhy(r) {
  if (!r) return '';
  if (r.reason) return r.reason;
  if (r.routerError) return 'Router down';
  return r.winRate != null ? `win rate ${r.winRate} vs threshold ${r.threshold}` : '';
}

function traceHtml(m) {
  const tr = m.trace;
  if (!tr) return '';
  const steps = [];
  const now = Date.now();
  const live = m.streaming;
  const step = (cls, text, t) => steps.push(`<li class="${cls}"><span class="st">${cls === 'ok' ? '✓' : cls === 'bad' ? '✕' : ''}</span><span>${text}</span><span class="t">${t ?? ''}</span></li>`);

  step('ok', 'Sent to the Interceptor', '');
  if (tr.routed) {
    const r = tr.routed;
    const why = r.reason || (r.routerError ? `Router down (${esc(r.routerError)}), used the fallback` : r.winRate != null ? `strong win rate ${r.winRate} vs threshold ${r.threshold}` : '');
    step('ok', `Routed to <code>${esc(r.model)}</code>${why ? ` · ${esc(why)}` : ''}${r.transforms?.length ? ` · ${esc(r.transforms.join(', '))}` : ''}`, fmtMs(r.routeMs));
  } else if (live) {
    step('now', 'Router is choosing a model…', fmtMs(now - tr.start));
  }
  if (tr.answered) {
    const a = tr.answered;
    const fb = a.fallbacks > 0 ? ` after ${a.fallbacks} fallback${a.fallbacks > 1 ? 's' : ''}` : '';
    const served = a.servedBy && a.servedBy !== tr.routed?.model ? ` · served by <code>${esc(a.servedBy)}</code>` : '';
    step(a.status >= 400 ? 'bad' : 'ok', `Gateway answered${a.status ? ` (HTTP ${a.status})` : ''}${fb}${served}`, fmtMs(a.ms));
  } else if (live && tr.routed) {
    step('now', `Waiting for <code>${esc(tr.routed.model)}</code>…`, fmtMs(now - tr.start));
  }
  if (tr.firstToken != null) {
    const done = tr.done != null;
    const tok = tr.usage?.completion_tokens ?? tr.chunks;
    const secs = ((done ? tr.done : now - tr.start) - tr.firstToken) / 1000;
    const rate = secs > 0.2 && tok ? ` · ${(tok / secs).toFixed(0)} tok/s` : '';
    step(done ? 'ok' : 'now', `${done ? 'Reply finished' : 'Writing'} · ${tok ?? 0} ${tr.usage ? 'tokens' : 'chunks'}${rate}`, `first token ${fmtMs(tr.firstToken)}`);
  } else if (live && tr.answered) {
    step('now', 'Waiting for the first token…', fmtMs(now - tr.start));
  }
  if (tr.error) step('bad', esc(tr.error), '');
  return `<ul class="trace">${steps.join('')}</ul>`;
}

function metaHtml(m) {
  const tr = m.trace, meta = m.meta || {};
  const model = tr?.answered?.servedBy || tr?.routed?.model || meta.model;
  const bits = [
    model && `<code>${esc(model)}</code>`,
    (routeWhy(tr?.routed) || meta.route) && esc(routeWhy(tr?.routed) || meta.route),
    tr?.answered?.fallbacks > 0 && `<span class="warn">${tr.answered.fallbacks} fallback${tr.answered.fallbacks > 1 ? 's' : ''}</span>`,
    (tr?.done ?? meta.ms) != null && fmtMs(tr?.done ?? meta.ms),
    tr?.usage && `${tr.usage.prompt_tokens ?? '?'} in · ${tr.usage.completion_tokens ?? '?'} out`,
  ].filter(Boolean);
  if (!bits.length) return '';
  return `<div class="meta">${bits.join(' · ')}${tr ? `<details><summary>How this reply was made</summary>${traceHtml(m)}</details>` : ''}</div>`;
}

function messageHtml(m, i, list) {
  const lastAssistant = m.role === 'assistant' && i === list.length - 1;
  const speaking = speech.current === m.id;
  if (m.role === 'user') {
    return `<div class="msg user" data-id="${m.id}"><div class="who">You<span class="actions">
        <button data-act="copy" title="Copy">${ICONS.copy}</button>
        <button data-act="edit" title="Edit and resend">${ICONS.edit}</button></span></div>
      ${attachmentsHtml(m.attachments)}${m.content ? `<div class="bubble">${esc(m.content)}</div>` : ''}</div>`;
  }
  if (m.role === 'error') {
    return `<div class="msg error" data-id="${m.id}"><div class="who">Error<span class="actions">
        ${i === list.length - 1 ? `<button data-act="retry" title="Try again">${ICONS.retry} Retry</button>` : ''}
        <button data-act="copy" title="Copy">${ICONS.copy}</button></span></div>
      <div class="bubble">${esc(m.content)}</div>${m.trace ? `<div class="meta"><details open><summary>What happened</summary>${traceHtml(m)}</details></div>` : ''}</div>`;
  }
  return `<div class="msg assistant${m.streaming ? ' streaming' : ''}" data-id="${m.id}"><div class="who">Assistant<span class="actions">
      <button data-act="copy" title="Copy as Markdown">${ICONS.copy}</button>
      <button data-act="speak" title="${speaking ? 'Stop reading' : 'Read aloud'}" class="${speaking ? 'speaking' : ''}">${speaking ? ICONS.stop : ICONS.speak}</button>
      ${lastAssistant && !m.streaming ? `<button data-act="retry" title="Regenerate">${ICONS.retry}</button>` : ''}</span></div>
    <div class="bubble"><div class="live-trace">${m.streaming ? traceHtml(m) : ''}</div>
      <div class="md${m.streaming && m.content ? ' cursor' : ''}">${m.content ? render(m.content) : m.streaming ? '' : '<span class="muted">(empty reply)</span>'}</div>
      <div class="meta-wrap">${m.streaming ? '' : metaHtml(m)}</div></div></div>`;
}

let stickToBottom = true;
$('log').addEventListener('scroll', () => {
  const log = $('log');
  stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
});

function drawLog() {
  const log = $('log');
  log.innerHTML = chat.messages.length ? chat.messages.map(messageHtml).join('') : emptyState();
  stickToBottom = true;
  log.scrollTop = log.scrollHeight;
  drawHint();
}

// Redraw one message in place (streaming), at most once per frame
const dirty = new Set();
let frame = 0;
function redraw(m) {
  dirty.add(m);
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    for (const msg of dirty) {
      if (!chat.messages.includes(msg)) continue;
      const el = $('log').querySelector(`.msg[data-id="${msg.id}"]`);
      const i = chat.messages.indexOf(msg);
      const html = messageHtml(msg, i, chat.messages);
      if (el) el.outerHTML = html; else drawLog();
    }
    dirty.clear();
    if (stickToBottom) $('log').scrollTop = $('log').scrollHeight;
  });
}
// keep elapsed times ticking while a reply is pending
setInterval(() => { for (const { reply } of running.values()) if (chat.messages.includes(reply)) redraw(reply); }, 250);

$('log').addEventListener('click', async (e) => {
  const codeBtn = e.target.closest('.copy-code');
  if (codeBtn) {
    await copyText(codeBtn.closest('.code').querySelector('code').textContent);
    flashCopied(codeBtn);
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.msg').dataset.id;
  const i = chat.messages.findIndex(m => m.id === id);
  const m = chat.messages[i];
  if (!m) return;
  switch (btn.dataset.act) {
    case 'copy': await copyText(m.content); flashCopied(btn); break;
    case 'speak': speech.current === m.id ? speech.stop() : speech.say(m.content, m.id); break;
    case 'retry': regenerate(); break;
    case 'edit':
      if (running.has(chat.id)) return toast('Stop the current reply first.');
      if (i < chat.messages.length - 1 && !confirm('Edit this message? The replies after it will be removed.')) return;
      $('input').value = m.content;
      pending = m.attachments || [];
      chat.messages.splice(i);
      saveChat(chat); drawLog(); drawChips(); autoGrow(); drawList();
      $('input').focus();
      break;
  }
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function contextText(c) {
  const parts = [];
  if (c.system?.trim()) parts.push(c.system.trim());
  if (c.notes?.trim()) parts.push(`Context notes from the user:\n\n${c.notes.trim()}`);
  return parts.join('\n\n');
}

function userContent(m) {
  const files = (m.attachments || []).filter(a => a.kind === 'text');
  const images = (m.attachments || []).filter(a => a.kind === 'image');
  const text = [m.content, ...files.map(f => `<file name="${f.name}">\n${f.text}\n</file>`)].filter(Boolean).join('\n\n');
  if (!images.length) return text;
  return [{ type: 'text', text: text || '(see image)' }, ...images.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }))];
}

function apiMessages(c, upTo) {
  const sys = contextText(c);
  return [
    ...(sys ? [{ role: 'system', content: sys }] : []),
    ...c.messages.slice(0, upTo)
      .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.streaming)
      .map(m => ({ role: m.role, content: m.role === 'user' ? userContent(m) : m.content })),
  ];
}

function busy(on) {
  $('send').textContent = on ? 'Stop' : 'Send';
  $('send').type = on ? 'button' : 'submit';
  $('send').classList.toggle('primary', !on);
}

async function send(text, attachments) {
  const c = chat;
  if (text || attachments.length) c.messages.push({ id: uid(), role: 'user', content: text, attachments: attachments.length ? attachments : undefined, time: Date.now() });
  await runReply(c);
}

function regenerate() {
  const c = chat;
  if (running.has(c.id)) return;
  while (c.messages.length && c.messages[c.messages.length - 1].role !== 'user') c.messages.pop();
  if (!c.messages.length) return;
  runReply(c);
}

async function runReply(c) {
  const reply = { id: uid(), role: 'assistant', content: '', streaming: true, time: Date.now(), trace: { start: Date.now(), chunks: 0 } };
  c.messages.push(reply);
  saveChat(c);
  if (chat === c) { drawLog(); $('title').placeholder = chatTitle(c); }

  const stream = $('stream').checked;
  const body = { model: 'auto', messages: apiMessages(c, c.messages.length - 1), stream };
  if (stream) body.stream_options = { include_usage: true };
  const maxTokens = parseInt($('maxTokens').value, 10);
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if ($('temperature').value !== '') body.temperature = Number($('temperature').value);
  const clientId = reply.id;
  const headers = { 'content-type': 'application/json', 'x-harness-request-id': clientId };
  if ($('model').value.trim()) headers['x-harness-model'] = $('model').value.trim();

  const controller = new AbortController();
  running.set(c.id, { controller, reply });
  waiting.set(clientId, reply);
  if (chat === c) busy(true);
  drawList();
  speech.beginReply(reply);

  const tr = reply.trace;
  try {
    const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    // the same facts the live feed sends, from the headers, in case it's not connected
    tr.routed = tr.routed || { model: res.headers.get('x-harness-model'), reason: res.headers.get('x-harness-route') };
    tr.answered = {
      ...tr.answered,
      status: res.status,
      ms: tr.answered?.ms ?? Date.now() - tr.start,
      servedBy: res.headers.get('x-litellm-model-group') || tr.answered?.servedBy || null,
      fallbacks: parseInt(res.headers.get('x-litellm-attempted-fallbacks'), 10) || tr.answered?.fallbacks || 0,
    };
    reply.meta = { model: tr.routed.model, route: routeWhy(tr.routed) };
    redraw(reply);
    if (!res.ok) {
      const errText = await res.text();
      let msg = errText;
      try { const j = JSON.parse(errText); msg = j.error?.message || j.error || errText; } catch {}
      throw new Error(`HTTP ${res.status}: ${String(msg).slice(0, 800)}`);
    }
    if (stream && res.body) {
      await readStream(res.body, reply, c);
    } else {
      const j = await res.json();
      reply.content = j.choices?.[0]?.message?.content ?? '';
      tr.firstToken = Date.now() - tr.start;
      tr.usage = j.usage || null;
      speech.feed(reply);
    }
    tr.done = Date.now() - tr.start;
  } catch (err) {
    tr.done = Date.now() - tr.start;
    if (err.name === 'AbortError') {
      reply.content += reply.content ? '\n\n*(stopped)*' : '*(stopped)*';
    } else if (reply.content) {
      reply.content += `\n\n*(cut off: ${err.message})*`;
    } else {
      // keep the trace on the error so it says how far the request got
      tr.error = err.message.startsWith('HTTP') ? null : err.message;
      c.messages.splice(c.messages.indexOf(reply), 1, { id: reply.id, role: 'error', content: err.message, trace: tr, time: Date.now() });
    }
  } finally {
    reply.streaming = false;
    running.delete(c.id);
    waiting.delete(clientId);
    saveChat(c);
    if (chat === c) { busy(false); drawLog(); }
    drawList();
    speech.endReply(reply);
  }
}

// OpenAI server-sent events: lines of "data: {json}", ending with "data: [DONE]"
async function readStream(stream, reply, c) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const tr = reply.trace;
  let buffer = '', lastSave = Date.now();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim();
      if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (j.usage) tr.usage = j.usage;
      const delta = j.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        if (tr.firstToken == null) tr.firstToken = Date.now() - tr.start;
        tr.chunks++;
        reply.content += delta;
      }
    }
    redraw(reply);
    speech.feed(reply);
    if (Date.now() - lastSave > 2000) { saveChat(c, { touch: false }); lastSave = Date.now(); }
  }
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});
function submit() {
  const text = $('input').value.trim();
  if ((!text && !pending.length) || running.has(chat.id)) return;
  dictation.stop();
  const attachments = pending;
  $('input').value = '';
  pending = [];
  chat.draft = ''; chat.pendingAttachments = [];
  drawChips(); autoGrow();
  send(text, attachments);
}
$('send').addEventListener('click', (e) => {
  const r = running.get(chat.id);
  if (r) { e.preventDefault(); r.controller.abort(); }
});

function autoGrow() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 240) + 'px';
  drawHint();
}
$('input').addEventListener('input', autoGrow);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});

function drawContextSize() {
  const chars = ($('system').value + $('notes').value).length;
  $('contextSize').textContent = chars ? `About ${approxTokens(chars).toLocaleString()} tokens of context sent with every message.` : '';
  drawHint();
}

function drawHint() {
  const bits = ['Enter to send · Shift+Enter for a new line'];
  const ctx = (chat?.system || '').length + (chat?.notes || '').length + pending.reduce((n, a) => n + (a.text?.length || 0), 0);
  const hist = (chat?.messages || []).reduce((n, m) => n + String(m.content).length, 0);
  const total = approxTokens(ctx + hist + $('input').value.length);
  if (total) bits.push(`≈ ${total.toLocaleString()} tokens in this request${pending.some(a => a.kind === 'image') ? ' plus images' : ''}`);
  if ($('model').value.trim()) bits.push(`model pinned to ${esc($('model').value.trim())}`);
  if ($('handsFree').checked) bits.push('hands-free on');
  $('hint').innerHTML = bits.map(b => `<span>${b}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Attachments: text files go in as <file> blocks, images as image parts
// ---------------------------------------------------------------------------
let pending = [];
const MAX_TEXT = 400_000;
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|psm1|bat|cmd|sql|lua|r|pl|ex|exs|vue|svelte|dockerfile|gitignore|tf|gradle|properties)$/i;

function drawChips() {
  $('chips').innerHTML = pending.map((a, k) => `<span class="chip" title="${esc(a.name)}${a.text ? ` · ${a.text.length.toLocaleString()} chars` : ''}">
      ${a.kind === 'image' ? `<img src="${esc(a.dataUrl)}" alt="">` : '📄'}<span>${esc(a.name)}</span>
      <button type="button" data-rm="${k}" aria-label="Remove">×</button></span>`).join('');
  drawHint();
}
$('chips').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { pending.splice(Number(rm.dataset.rm), 1); drawChips(); }
});

// Images are shrunk to 1600 px so they fit in browser storage
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL(file.type === 'image/png' && scale === 1 && file.size < 400_000 ? 'image/png' : 'image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not a readable image')); };
    img.src = url;
  });
}

async function addFiles(files) {
  for (const file of files) {
    try {
      if (file.type.startsWith('image/')) {
        pending.push({ kind: 'image', name: file.name || 'pasted image', dataUrl: await shrinkImage(file) });
      } else if (file.type.startsWith('text/') || /json|xml|javascript|yaml|x-sh|sql/.test(file.type) || TEXT_EXT.test(file.name) || !file.type) {
        let text = await file.text();
        if (text.includes('\u0000')) throw new Error('looks like a binary file');
        if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); toast(`${file.name} is long; only the first ${MAX_TEXT.toLocaleString()} characters are attached.`); }
        pending.push({ kind: 'text', name: file.name, text });
      } else {
        toast(`${file.name}: only text files and images can be attached.`);
      }
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
    }
  }
  drawChips();
}

$('attach').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => { addFiles([...$('fileInput').files]); $('fileInput').value = ''; });
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; $('drop').hidden = true;
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function chatMarkdown(c) {
  const out = [`# ${chatTitle(c)}`, '', `_Exported from Harness Chat on ${new Date().toLocaleString()}_`, ''];
  if (c.system?.trim()) out.push('## System prompt', '', c.system.trim(), '');
  if (c.notes?.trim()) out.push('## Context notes', '', c.notes.trim(), '');
  for (const m of c.messages) {
    if (m.role === 'user') {
      out.push('## You', '');
      if (m.content) out.push(m.content, '');
      for (const a of m.attachments || []) {
        if (a.kind === 'image') out.push(`_Attached image: ${a.name}_`, '');
        else out.push(`<details><summary>Attached file: ${a.name}</summary>`, '', '```', a.text, '```', '', '</details>', '');
      }
    } else if (m.role === 'assistant') {
      const tr = m.trace;
      const model = tr?.answered?.servedBy || tr?.routed?.model || m.meta?.model;
      const why = routeWhy(tr?.routed) || m.meta?.route;
      out.push(`## Assistant${model ? ` (${model}${why ? `, ${why}` : ''})` : ''}`, '', m.content, '');
    } else if (m.role === 'error') {
      out.push('## Error', '', '```', m.content, '```', '');
    }
  }
  return out.join('\n');
}
const fileName = (c) => `${chatTitle(c).replace(/[\\/:*?"<>|\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat'}.md`;

$('exportChat').addEventListener('click', () => {
  if (!chat.messages.length) return toast('Nothing to export yet.');
  download(fileName(chat), chatMarkdown(chat));
});
$('copyChat').addEventListener('click', async () => {
  if (!chat.messages.length) return toast('Nothing to copy yet.');
  await copyText(chatMarkdown(chat));
  toast('Chat copied as Markdown.');
});
$('exportAll').addEventListener('click', () => {
  const chats = index.map(e => loadChat(e.id)).filter(Boolean);
  if (!chats.length) return toast('No saved chats yet.');
  download(`harness-chats-${new Date().toISOString().slice(0, 10)}.md`, chats.map(chatMarkdown).join('\n\n---\n\n'));
});

// ---------------------------------------------------------------------------
// Read aloud. Two engines: the browser's own voices (speechSynthesis), or a
// TTS server the harness forwards to (/ui/api/tts: Kokoro, OpenAI, LiteLLM...).
// Replies can be read sentence by sentence as they stream in.
// ---------------------------------------------------------------------------

// Browser voices. Chrome stops long utterances after ~15 s, hence short pieces.
const browserTTS = {
  ok: 'speechSynthesis' in window,
  play(text, done) {
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find(x => x.voiceURI === $('voice').value);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Number($('rate').value) || 1;
    u.pitch = Number($('pitch').value);
    u.volume = Number($('volume').value);
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  },
  stop() { if (this.ok) speechSynthesis.cancel(); },
};

// Harness TTS server: fetch audio per piece, a couple ahead, and play in order
const serverTTS = {
  info: null,           // GET /ui/api/tts
  items: [],            // [{ text, done, audio: Promise<url> }]
  playing: null,
  el: new Audio(),
  aborter: new AbortController(),
  get ok() { return !!this.info?.configured; },

  fetchAudio(text) {
    return fetch('api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: $('serverVoice').value || undefined, speed: Number($('rate').value) || 1 }),
      signal: this.aborter.signal,
    }).then(async (res) => {
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      return URL.createObjectURL(await res.blob());
    });
  },

  play(text, done) {
    this.items.push({ text, done });
    this.pump();
  },

  // keep two pieces fetching ahead of the one playing
  pump() {
    for (const item of this.items.slice(0, 3)) if (!item.audio) {
      item.audio = this.fetchAudio(item.text);
      item.audio.catch(() => {});
    }
    if (this.playing || !this.items.length) return;
    const item = this.playing = this.items.shift();
    const next = () => { this.playing = null; item.done(); this.pump(); };
    item.audio.then((url) => {
      if (this.playing !== item) return URL.revokeObjectURL(url);
      this.el.src = url;
      this.el.volume = Number($('volume').value);
      this.el.onended = this.el.onerror = () => { URL.revokeObjectURL(url); next(); };
      this.el.play().catch((err) => { toast(`Read aloud: ${err.message}`); next(); });
    }, (err) => {
      if (err.name !== 'AbortError') toast(`TTS server: ${err.message}`);
      if (this.playing === item) next();
    });
  },

  stop() {
    this.aborter.abort();
    this.aborter = new AbortController();
    this.items = [];
    this.playing = null;
    this.el.pause();
    this.el.removeAttribute('src');
  },
};

const speech = {
  current: null,      // message id being read
  queue: 0,
  spoken: new Map(),  // reply id -> chars of content already queued
  get engine() { return $('ttsEngine').value === 'server' && serverTTS.ok ? serverTTS : browserTTS; },
  get ok() { return browserTTS.ok || serverTTS.ok; },

  enqueue(text, id) {
    if (!this.ok || !text.trim()) return;
    const engine = this.engine;
    // the server takes longer pieces; fewer requests, smoother audio
    const max = engine === serverTTS ? 400 : 220;
    const pieces = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [text];
    let chunk = '';
    const flush = () => {
      if (!/[\p{L}\p{N}]/u.test(chunk)) { chunk = ''; return; }
      this.queue++;
      engine.play(chunk.trim(), () => { if (--this.queue <= 0) this.idle(id); });
      chunk = '';
    };
    for (const p of pieces) { if ((chunk + p).length > max) flush(); chunk += p; }
    flush();
    this.current = id;
    this.mark(id);
  },

  say(markdown, id) {
    this.stop();
    dictation.pause();
    this.enqueue(toSpeech(markdown), id);
  },

  stop() {
    const was = this.current;
    this.queue = 0;
    this.current = null;
    browserTTS.stop();
    serverTTS.stop();
    if (was) this.mark(was);
  },

  idle(id) {
    this.queue = 0;
    if (this.current === id) this.current = null;
    this.mark(id);
    // hands-free: wait for the reply to finish streaming before listening again
    if (!running.has(chat.id) && $('handsFree').checked) dictation.resume();
  },

  mark(id) {
    const m = chat.messages.find(x => x.id === id);
    if (m) redraw(m);
  },

  beginReply(reply) {
    if (!$('autoSpeak').checked) return;
    this.stop();
    this.spoken.set(reply.id, 0);
  },

  // Queue every finished sentence that hasn't been read yet, outside code
  feed(reply, final = false) {
    if (!this.spoken.has(reply.id)) return;
    const text = reply.content;
    let from = this.spoken.get(reply.id);
    let to = text.length;
    if (!final) {
      const fences = (text.match(/```/g) || []).length;
      if (fences % 2) to = text.lastIndexOf('```'); // inside an open code block: wait for it to close
      const tail = text.slice(from, to);
      // the last line break or sentence end (not a "2." list number)
      let end = tail.lastIndexOf('\n');
      for (const m of tail.matchAll(/[^\d\s][.!?](?=\s)/g)) end = Math.max(end, m.index + 1);
      if (end < 0) return;
      to = from + end + 1;
      // never stop inside a code block: wait until its closing fence is in
      const before = text.slice(0, to);
      if ((before.match(/```/g) || []).length % 2) to = before.lastIndexOf('```');
    }
    if (to <= from) return;
    this.spoken.set(reply.id, to);
    dictation.pause();
    this.enqueue(toSpeech(text.slice(from, to)), reply.id);
  },

  endReply(reply) {
    if (this.spoken.has(reply.id)) {
      if (!/\*\((stopped|cut off)/.test(reply.content)) this.feed(reply, true);
      this.spoken.delete(reply.id);
    }
    if (!this.queue && $('handsFree').checked) dictation.resume();
  },
};

// Neural voices sound far better than the old ones: Edge's "Online (Natural)",
// Chrome's "Google ...", macOS "Premium"/"Enhanced". Pick one by default.
const voiceScore = (v) => /natural|neural/i.test(v.name) ? 3 : /premium|enhanced/i.test(v.name) ? 2 : /^google/i.test(v.name) ? 1 : 0;

function loadVoices() {
  if (!browserTTS.ok) return;
  const voices = speechSynthesis.getVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  const groups = new Map();
  for (const v of [...voices].sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name))) {
    const key = v.lang.slice(0, 2);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  let names = null;
  try { names = new Intl.DisplayNames([navigator.language, 'en'], { type: 'language' }); } catch {}
  const label = (code) => { try { return names?.of(code) || code; } catch { return code; } };
  const order = [...groups.keys()].sort((a, b) => (b === lang) - (a === lang) || label(a).localeCompare(label(b)));
  $('voice').innerHTML = '<option value="">System default</option>' + order.map(code =>
    `<optgroup label="${esc(label(code))}">${groups.get(code).map(v =>
      `<option value="${esc(v.voiceURI)}">${esc(v.name.replace(/^Microsoft /, ''))} (${esc(v.lang)})${voiceScore(v) >= 3 ? ' ★' : ''}${v.localService ? '' : ' · online'}</option>`).join('')}</optgroup>`).join('');
  const best = groups.get(lang)?.[0];
  $('voice').value = prefs.voice && voices.some(v => v.voiceURI === prefs.voice) ? prefs.voice
    : best && voiceScore(best) > 0 ? best.voiceURI : '';
}
if (browserTTS.ok) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

async function loadServerTTS() {
  try {
    serverTTS.info = await (await fetch('api/tts')).json();
  } catch {
    serverTTS.info = null;
  }
  const info = serverTTS.info;
  const opt = $('ttsEngine').querySelector('option[value=server]');
  opt.disabled = !info?.configured;
  opt.textContent = info?.configured ? `Harness TTS server (${info.model})` : 'Harness TTS server (not set up)';
  if (info?.configured) {
    $('serverVoice').innerHTML = (info.voices.length ? info.voices : [info.voice]).map(v => `<option value="${esc(v)}">${esc(v || "Model default")}</option>`).join('');
    $('serverVoice').value = prefs.serverVoice && info.voices.includes(prefs.serverVoice) ? prefs.serverVoice : info.voice;
  }
  drawEngine();
}

function drawEngine() {
  const server = $('ttsEngine').value === 'server' && serverTTS.ok;
  if ($('ttsEngine').value === 'server' && !serverTTS.ok) $('ttsEngine').value = 'browser';
  $('voice').hidden = server;
  $('serverVoice').hidden = !server;
  document.querySelector('[data-engine=browser]').hidden = server;
  $('voiceNote').textContent = [
    !SR && 'Dictation needs Chrome or Edge.',
    SR && !window.isSecureContext && 'The microphone works only on http://localhost or https.',
    SR && 'Chrome and Edge send dictated audio to their speech service.',
    server ? `Replies are spoken by ${serverTTS.info.model} at ${serverTTS.info.host}.`
      : !browserTTS.ok ? 'This browser cannot read aloud.'
      : 'For browser voices, Edge’s ★ Natural voices sound best. Set TTS_URL to use a TTS server instead (see the README).',
  ].filter(Boolean).join(' ');
}

$('testVoice').addEventListener('click', () => {
  if (speech.current === 'test') return speech.stop();
  speech.say('Hi! This is how replies will sound when they are read aloud.', 'test');
});

// ---------------------------------------------------------------------------
// Dictation (SpeechRecognition). Chrome and Edge have it; Firefox doesn't.
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const dictation = {
  rec: null,
  want: false,       // the user turned the mic on
  paused: false,     // paused while a reply is read aloud
  base: '',          // text in the box before this stretch of speech
  silence: null,

  start() {
    if (!SR) return toast('Dictation needs Chrome or Edge.');
    speech.stop();
    this.want = true; this.paused = false;
    this.listen();
  },

  listen() {
    if (this.rec) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = $('sttLang').value.trim() || navigator.language || 'en-US';
    const box = $('input');
    this.base = box.value ? box.value.replace(/\s*$/, ' ') : '';
    rec.onresult = (e) => {
      let finalText = '', interim = '';
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const r = e.results[k];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      if (finalText) this.base += finalText.trim() + ' ';
      box.value = this.base + interim;
      autoGrow();
      clearTimeout(this.silence);
      if ($('autoSend').checked && this.base.trim() && !interim) {
        this.silence = setTimeout(() => {
          if (!this.want || running.has(chat.id)) return;
          this.base = '';
          const handsFree = $('handsFree').checked;
          submit();
          // hands-free waits, mic off, until the reply has been read
          if (handsFree) { this.want = true; this.paused = true; this.draw(); }
        }, 1200);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.want = false;
      toast(e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'The microphone is blocked. Allow it for this page (it needs http://localhost or https).'
        : `Dictation stopped: ${e.error}`);
    };
    rec.onend = () => {
      this.rec = null;
      // browsers end recognition after a pause; keep going while the mic is on
      if (this.want && !this.paused) setTimeout(() => this.want && !this.paused && this.listen(), 150);
      this.draw();
    };
    try { rec.start(); this.rec = rec; } catch (err) { toast(`Dictation: ${err.message}`); this.want = false; }
    this.draw();
  },

  stop() {
    this.want = false; this.paused = false;
    clearTimeout(this.silence);
    this.rec?.stop();
    this.draw();
  },

  // Stop listening while the page talks, so it doesn't hear itself
  pause() {
    if (!this.want) return;
    this.paused = true;
    clearTimeout(this.silence);
    this.rec?.abort();
    this.draw();
  },

  resume() {
    if (!SR || !$('handsFree').checked) return;
    this.want = true; this.paused = false;
    this.listen();
  },

  draw() {
    const on = this.want && !this.paused;
    $('mic').classList.toggle('listening', on);
    $('mic').title = !SR ? 'Dictation needs Chrome or Edge' : on ? 'Stop dictating (Ctrl+M)' : 'Dictate (Ctrl+M)';
  },
};
$('mic').addEventListener('click', () => (dictation.want && !dictation.paused ? dictation.stop() : dictation.start()));
if (!SR) $('mic').disabled = true;
loadServerTTS();

// ---------------------------------------------------------------------------
// Live activity: the Interceptor's feed of every request
// ---------------------------------------------------------------------------
const waiting = new Map();   // x-harness-request-id -> reply waiting on it
const feedRows = new Map();  // event id or pending key -> row data
let liveSource = null;

function onLive(update) {
  const { type, event } = update;
  const reply = event.clientId && waiting.get(event.clientId);
  if (reply) {
    const tr = reply.trace;
    if (type === 'route') tr.routed = { model: event.model, reason: event.reason, winRate: event.winRate, threshold: event.threshold, routerError: event.routerError, transforms: event.transforms, routeMs: event.routeMs };
    if (type === 'response') tr.answered = { status: event.status, ms: event.ms, servedBy: event.servedBy, fallbacks: event.fallbacks };
    if (type === 'error' && !tr.answered) tr.error = `Gateway: ${event.error}`;
    redraw(reply);
  }
  feedUpdate(type, event);
}

function feedUpdate(type, e) {
  const key = (x) => `p:${x.clientId || ''}:${x.path}:${x.prompt}`;
  if (type === 'routing') {
    feedRows.set(key(e), { pending: true, ...e, started: Date.now() });
  } else {
    feedRows.delete(key(e));
    feedRows.set(e.id, { ...(feedRows.get(e.id) || {}), ...e });
  }
  // keep the newest 80
  while (feedRows.size > 80) feedRows.delete(feedRows.keys().next().value);
  drawFeed();
}

let feedFrame = 0;
function drawFeed() {
  if ($('activity').hidden || feedFrame) return;
  feedFrame = requestAnimationFrame(() => {
    feedFrame = 0;
    const rows = [...feedRows.values()].reverse();
    if (!rows.length) return;
    const mine = (e) => e.clientId && (waiting.has(e.clientId) || index.length && chatHasMessage(e.clientId));
    $('feed').innerHTML = rows.map(e => {
      const time = new Date(e.time).toLocaleTimeString();
      if (e.pending) {
        return `<li class="ev pending${mine(e) ? ' mine' : ''}"><div class="row"><b>Routing…</b><span class="muted">${esc(e.path)}</span><span class="t">${fmtMs(Date.now() - e.started)}</span></div>
          ${e.prompt ? `<div class="p">${esc(e.prompt)}</div>` : ''}</li>`;
      }
      const status = e.error ? `<span class="bad">${esc(e.error)}</span>`
        : e.status == null ? '<span class="muted">waiting for the model…</span>'
        : `<span class="${e.status >= 400 ? 'bad' : 'ok'}">HTTP ${e.status}</span>`;
      const why = e.reason || (e.routerError ? 'Router down' : e.winRate != null ? `win ${e.winRate} / thr ${e.threshold}` : '');
      const timing = [e.routeMs != null && `route ${fmtMs(e.routeMs)}`, e.ms != null && `answer ${fmtMs(e.ms)}`, e.doneMs != null && `done ${fmtMs(e.doneMs)}`].filter(Boolean).join(' · ');
      return `<li class="ev${mine(e) ? ' mine' : ''}">
        <div class="row"><code>${esc(e.model)}</code><span class="t">${time}</span></div>
        <div class="row muted">${esc(e.path)}${e.tools ? ' · tools' : ''}${why ? ` · ${esc(why)}` : ''}</div>
        <div class="row">${status}${e.fallbacks > 0 ? ` <span class="warn">${e.fallbacks} fallback${e.fallbacks > 1 ? 's' : ''}</span>` : ''}${e.servedBy && e.servedBy !== e.model ? ` <span class="muted">→ ${esc(e.servedBy)}</span>` : ''}</div>
        ${timing ? `<div class="row muted">${timing}${e.transforms?.length ? ` · ${esc(e.transforms.join(', '))}` : ''}</div>` : ''}
        ${e.prompt ? `<div class="p" title="${esc(e.prompt)}">${esc(e.prompt)}</div>` : ''}</li>`;
    }).join('');
  });
}
const chatHasMessage = (id) => chat?.messages.some(m => m.id === id);
setInterval(() => { if ([...feedRows.values()].some(r => r.pending)) drawFeed(); }, 500);

function connectLive() {
  if (!('EventSource' in window)) return;
  liveSource = new EventSource('api/live');
  const state = (on, text) => { $('liveState').className = `live ${on ? 'on' : 'off'}`; $('liveState').lastElementChild.textContent = text; };
  liveSource.onopen = () => state(true, 'live');
  liveSource.onerror = () => state(false, 'reconnecting');
  liveSource.onmessage = (msg) => { try { onLive(JSON.parse(msg.data)); } catch {} };
}

async function loadRecent() {
  try {
    const events = await (await fetch('api/events?limit=30')).json();
    for (const e of events.reverse()) feedRows.set(e.id, e);
    drawFeed();
  } catch {}
}

async function loadHealth() {
  if ($('activity').hidden) return;
  try {
    const { components } = await (await fetch('api/status')).json();
    $('health').innerHTML = components.map(c => `<span title="${esc(c.url)}${c.error ? ` · ${esc(c.error)}` : ''}"><span class="dot ${c.ok ? 'ok' : c.optional ? 'off' : 'bad'}"></span>${esc(c.name)}</span>`).join('');
  } catch {
    $('health').innerHTML = '<span><span class="dot bad"></span>Interceptor unreachable</span>';
  }
}
setInterval(loadHealth, 10000);

function setActivity(open) {
  $('activity').hidden = !open;
  $('toggleActivity').classList.toggle('on', open);
  prefs.activity = open; store.set(PREF_KEY, prefs);
  if (open) { drawFeed(); loadHealth(); }
}
$('toggleActivity').addEventListener('click', () => setActivity($('activity').hidden));
$('closeActivity').addEventListener('click', () => setActivity(false));
$('toggleOptions').addEventListener('click', () => {
  const open = $('options').hidden;
  $('options').hidden = !open;
  $('toggleOptions').classList.toggle('on', open);
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openChat(null); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('app').classList.add('side-open'); $('search').focus(); $('search').select(); }
  else if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); $('mic').click(); }
  else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepChat(e.key === 'ArrowUp' ? -1 : 1); }
  else if (e.key === 'Escape') {
    if (speech.current) speech.stop();
    else if (running.has(chat.id)) running.get(chat.id).controller.abort();
    else $('app').classList.remove('side-open');
  }
});
window.addEventListener('beforeunload', saveDraft);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
fetch('api/models').then(r => r.json()).then(({ models }) => {
  $('models').innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
}).catch(() => {});

applyPrefs();
let lastOpen = null;
try { lastOpen = localStorage.getItem('harness-chat-open'); } catch {}
openChat(index.some(e => e.id === lastOpen) ? lastOpen : index[0]?.id);
connectLive();
loadRecent();
setActivity(!!prefs.activity);
setInterval(drawList, 60000);
