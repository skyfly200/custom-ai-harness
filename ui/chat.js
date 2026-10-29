// Bright Chat, the chat page. Talks to the Interceptor like any other OpenAI client
// (POST /v1/chat/completions) and follows its live feed (/ui/api/live) to show
// what happens to each request. Chats live in this browser's localStorage.
'use strict';

const $ = (id) => document.getElementById(id);
const { render, toSpeech, escape: esc } = window.Markdown;
const modelAlias = window.ModelAlias;
const Tokens = window.Tokens;   // usage readings and estimates, shared with the Interceptor
const speechText = (markdown) => toSpeech(markdown, { clear: $('speakClear').checked });

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
  headset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M17 7 7 17M7 7l10 10"/></svg>',
  kit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.5L12 15l-1.8-4.5L5.5 9l4.7-1.4z"/><path d="M19 15l.8 2 2 .8-2 .7-.8 2-.8-2-2-.7 2-.8zM5 16l.6 1.4 1.4.6-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const setIcon = (id, name) => { $(id).innerHTML = ICONS[name]; };
setIcon('copyChat', 'copy'); setIcon('exportChat', 'download'); setIcon('toggleOptions', 'sliders');
setIcon('toggleActivity', 'pulse'); setIcon('attach', 'clip'); setIcon('mic', 'mic'); setIcon('handsFreeBtn', 'headset');
setIcon('toggleSide', 'panel'); setIcon('pagesMenu', 'menu'); setIcon('closeActivity', 'close'); setIcon('closeOptions', 'close'); setIcon('deleteChat', 'trash'); setIcon('exportAll', 'download'); setIcon('deleteAll', 'trash'); setIcon('kitBtn', 'kit');

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

// With a database on the server (DATABASE_URL), chats and the per-person lists are also kept there:
// each save is pushed a moment later and, at start, what other devices saved is pulled. localStorage
// stays the working copy, so the page is as quick as before and works unchanged with no database.
const SYNC_DATA = ['harness-projects', 'harness-skills', 'harness-commands', 'harness-schedules', 'harness-chat-prefs'];
const sync = {
  on: false, timers: new Map(), failed: false,
  api(path, opts = {}) {
    return fetch(`api/sync${path}`, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  },
  queue(key, fn) {
    if (!this.on) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(async () => {
      this.timers.delete(key);
      try { const r = await fn(); if (r && r.status >= 500) throw new Error(r.status); this.failed = false; } catch { this.failed = true; }
    }, 1500));
  },
  // Attachments are kept apart from the chat text: each is uploaded once and the synced message carries only
  // a stub {kind, name, size, aid}. This page keeps the bytes; another device fetches them when it needs them.
  bytesOf(a) { return a.kind === 'image' ? a.dataUrl : a.text; },
  stub(a) { return { kind: a.kind, name: a.name, size: a.size ?? (this.bytesOf(a) || '').length, ...(a.aid ? { aid: a.aid } : {}) }; },
  async uploadAttachments(c) {
    for (const m of c.messages || []) {
      for (const a of m.attachments || []) {
        const body = this.bytesOf(a);
        if (a.aid || !body || a.syncFailed === body.length) continue;
        try {
          const r = await this.api(`/chats/${c.id}/attachments`, { method: 'POST', body: { kind: a.kind, name: a.name, body } });
          if (r.ok) { const j = await r.json(); a.aid = j.id; a.size = j.size; delete a.syncFailed; }
          else {
            a.syncFailed = body.length; // not retried until it changes
            const j = await r.json().catch(() => ({}));
            if (!this.warned) { this.warned = true; toast(`${a.name} stays on this device only: ${j.error || 'the server refused it'}.`); }
          }
        } catch { /* try again on the next save */ }
      }
    }
  },
  wire(messages) {
    return (messages || []).map(m => (m.attachments?.length ? { ...m, attachments: m.attachments.map(a => this.stub(a)) } : m));
  },
  snaps: new Map(), // chat id -> { version the server is at, known: Map(message id -> fingerprint of the copy it has) }
  pushChat(c) { this.queue(`c:${c.id}`, () => this.saveChat(c.id)); },
  flushNow(id) { clearTimeout(this.timers.get(`c:${id}`)); this.timers.delete(`c:${id}`); this.saveChat(id).catch(() => { this.failed = true; }); },
  // Send only the messages that changed since the last save, with the version this copy is based on. If the
  // server has moved on (another device, or the server itself added messages) it answers 409: pull, join, retry.
  async saveChat(id, attempt = 0) {
    const c = cache.get(id) || store.get(CHAT_KEY(id), null);
    if (!c || c.deleted) return;
    if (c.sharedFrom && c.sharedRole !== 'edit') return;
    const snap = this.snaps.get(id) || { version: Number(c.syncVersion) || 0, known: new Map() };
    const base = c.sharedFrom ? `/shared/${encodeURIComponent(c.sharedFrom)}/chats/${id}` : `/chats/${id}`;
    if (!c.sharedFrom) await this.uploadAttachments(c);
    const { upserts, order, fingerprints } = ChatMerge.delta(this.wire(c.messages), snap.known);
    // The linked folder belongs to the device it was linked on: it is not sent, so another device or a hosted server never sees it
    const { messages, syncVersion, repo: _folder, ...chatMeta } = c;
    const r = await this.api(`${base}/delta`, { method: 'PUT', body: { chat: chatMeta, order, upserts, base: snap.version } });
    if (r.status === 409 && attempt < 2) {
      const got = await this.api(base);
      if (got.status === 404) { this.snaps.delete(id); c.syncVersion = 0; return this.saveChat(id, attempt + 1); }
      if (!got.ok) return got;
      const remote = await got.json();
      const merged = ChatMerge.mergeChats(c, remote);
      const { messages: joined, ...rest } = merged;
      const keepRepo = c.repo;
      Object.assign(c, rest);
      if (keepRepo) c.repo = keepRepo;
      c.messages.splice(0, c.messages.length, ...joined);
      this.noteSaved(c.id, remote.syncVersion, remote.messages);
      return this.saveChat(id, attempt + 1);
    }
    if (!r.ok) return r;
    const { version } = await r.json();
    this.snaps.set(id, { version, known: fingerprints });
    c.syncVersion = version;
    try { localStorage.setItem(CHAT_KEY(id), JSON.stringify(c)); } catch {} // remember the version, without another push
  },
  noteSaved(id, version, messages) {
    this.snaps.set(id, { version, known: new Map((messages || []).map(m => [m.id, ChatMerge.fingerprint(m)])) });
  },
  pushData(key, value) {
    const updated = Date.now();
    try { localStorage.setItem(`harness-sync-ts:${key}`, String(updated)); } catch {}
    this.queue(`d:${key}`, () => this.api(`/data/${key}`, { method: 'PUT', body: { value, updated } }));
  },
  dropChat(id) { clearTimeout(this.timers.get(`c:${id}`)); this.timers.delete(`c:${id}`); if (this.on) this.api(`/chats/${id}`, { method: 'DELETE' }).catch(() => {}); },
  // Pull what is newer on the server, push what is newer here (a first sign-in uploads this browser's chats)
  async start() {
    await window.OwnerScope?.ready; // another person's copy in this browser is cleared first, never uploaded
    if (window.OwnerScope?.reloading || window.OwnerScope?.ok === false) return;
    let remote;
    try {
      const r = await fetch('api/sync', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      remote = await r.json();
    } catch { return; }
    if (!remote || !remote.db) return;
    this.on = true;
    this.serverSchedules = Boolean(remote.serverSchedules);
    let changed = false;
    const raw = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
    const byId = new Map(remote.chats.map(e => [e.id, e]));
    for (const e of remote.chats) {
      const local = index.find(x => x.id === e.id);
      if (e.deleted) {
        if (local) { index = index.filter(x => x.id !== e.id); store.remove(CHAT_KEY(e.id)); cache.delete(e.id); changed = true; }
        continue;
      }
      if (local && local.updated >= e.updated) continue;
      try {
        const r = await this.api(`/chats/${e.id}`);
        if (!r.ok) continue;
        const c = await r.json();
        raw(CHAT_KEY(c.id), c);
        this.noteSaved(c.id, c.syncVersion, c.messages);
        cache.delete(c.id);
        const entry = { id: c.id, title: chatTitle(c), updated: c.updated, count: (c.messages || []).length, project: c.project || undefined, caches: c.caches, ...(c.sharedFrom ? { sharedFrom: c.sharedFrom, sharedRole: c.sharedRole } : {}) };
        const i = index.findIndex(x => x.id === c.id);
        if (i >= 0) index[i] = entry; else index.push(entry);
        changed = true;
      } catch {}
    }
    index.sort((a, b) => b.updated - a.updated);
    raw(INDEX_KEY, index);
    this.canShare = Boolean(remote.canShare);
    const shared = await this.pullShared();
    if (shared.chats) changed = true;
    for (const e of index) {
      if (e.sharedFrom) continue; // pushed through the shared route, and only when it has changed
      const theirs = byId.get(e.id);
      if (theirs && !theirs.deleted && theirs.updated >= e.updated) continue;
      const c = store.get(CHAT_KEY(e.id), null);
      if (c) this.pushChat(c);
    }
    for (const key of SYNC_DATA) {
      const theirs = remote.data[key];
      let ours = 0;
      try { ours = Number(localStorage.getItem(`harness-sync-ts:${key}`)) || 0; } catch {}
      if (theirs && theirs.updated > ours) {
        raw(key, theirs.value);
        try { localStorage.setItem(`harness-sync-ts:${key}`, String(theirs.updated)); } catch {}
        changed = true;
      } else if (!theirs || ours > theirs.updated) {
        const v = store.get(key, null);
        if (v !== null) this.pushData(key, v);
      }
    }
    if (this.serverSchedules && schedules.some(x => !x.tz)) { schedules.forEach(x => { x.tz = x.tz || myZone; }); saveSchedules(); } // the server needs each schedule's time zone
    const guarded = sessionStorage.getItem('harness-sync-reloaded');
    if (changed && !guarded && !running.size) { sessionStorage.setItem('harness-sync-reloaded', '1'); location.reload(); }
    else { sessionStorage.removeItem('harness-sync-reloaded'); if (sharedProjects.length) { drawSide(); drawProjectBits(); drawHint(); } }
  },
};
// Projects other people shared with this account, and their chats. The list is kept in memory only; the chats are
// stored like any other (marked sharedFrom) and dropped again when the share is taken back.
sync.pullShared = async function () {
  const none = { chats: false, list: false };
  if (!this.on || !this.canShare) return none;
  let got;
  try { const r = await this.api('/shares'); if (!r.ok) return none; got = await r.json(); } catch { return none; }
  const raw = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  let changed = false;
  const before = JSON.stringify(sharedProjects);
  sharedProjects = got.withMe.map(w => ({ ...w.project, owner: w.owner, role: w.role }));
  const listChanged = JSON.stringify(sharedProjects) !== before;
  const listed = new Set();
  for (const w of got.withMe) {
    for (const e of w.chats) {
      listed.add(e.id);
      const local = index.find(x => x.id === e.id);
      if (local && local.updated >= e.updated && local.sharedRole === w.role) continue;
      if (chat?.id === e.id && running.has(e.id)) continue;
      try {
        const r = await this.api(`/shared/${encodeURIComponent(w.owner)}/chats/${e.id}`);
        if (!r.ok) continue;
        const c = await r.json();
        raw(CHAT_KEY(c.id), c);
        this.noteSaved(c.id, c.syncVersion, c.messages);
        cache.delete(c.id);
        const entry = { id: c.id, title: chatTitle(c), updated: c.updated, count: (c.messages || []).length, project: c.project || undefined, caches: c.caches, sharedFrom: w.owner, sharedRole: w.role };
        const i = index.findIndex(x => x.id === c.id);
        if (i >= 0) index[i] = entry; else index.push(entry);
        changed = true;
      } catch {}
    }
  }
  // a share that was taken back: its chats leave this browser
  for (const e of index.filter(x => x.sharedFrom && !listed.has(x.id))) {
    index = index.filter(x => x.id !== e.id); rawRemove(CHAT_KEY(e.id)); cache.delete(e.id); changed = true;
  }
  if (changed) { index.sort((a, b) => b.updated - a.updated); raw(INDEX_KEY, index); }
  return { chats: changed, list: listChanged };
};
// With schedules on the server, what it sends arrives as new chats and moved times: look for them now and then
sync.refresh = async function () {
  if (!this.on || !this.serverSchedules || document.hidden) return;
  let remote;
  try { const r = await fetch('api/sync', { headers: { accept: 'application/json' } }); if (!r.ok) return; remote = await r.json(); } catch { return; }
  const raw = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const theirs = remote.data?.[SCHEDULES_KEY];
  let ours = 0;
  try { ours = Number(localStorage.getItem(`harness-sync-ts:${SCHEDULES_KEY}`)) || 0; } catch {}
  if (theirs && theirs.updated > ours && !$('schedDialog').open) {
    schedules = theirs.value; raw(SCHEDULES_KEY, schedules);
    try { localStorage.setItem(`harness-sync-ts:${SCHEDULES_KEY}`, String(theirs.updated)); } catch {}
    drawSchedules();
  }
  let added = false;
  for (const e of remote.chats || []) {
    if (e.deleted || chat?.id === e.id || running.has(e.id)) continue;
    const local = index.find(x => x.id === e.id);
    if (local && local.updated >= e.updated) continue;
    try {
      const r = await this.api(`/chats/${e.id}`);
      if (!r.ok) continue;
      const c = await r.json();
      raw(CHAT_KEY(c.id), c);
      this.noteSaved(c.id, c.syncVersion, c.messages);
      cache.delete(c.id);
      const entry = { id: c.id, title: chatTitle(c), updated: c.updated, count: (c.messages || []).length, project: c.project || undefined, caches: c.caches, ...(c.sharedFrom ? { sharedFrom: c.sharedFrom, sharedRole: c.sharedRole } : {}) };
      const i = index.findIndex(x => x.id === c.id);
      if (i >= 0) index[i] = entry; else index.push(entry);
      added = true;
    } catch {}
  }
  if (added) { index.sort((a, b) => b.updated - a.updated); raw(INDEX_KEY, index); drawList(); }
};
setInterval(() => sync.refresh(), 60000);
setInterval(async () => {
  if (document.hidden) return;
  const r = await sync.pullShared();
  if (r.chats || r.list) { if (scope && !findProject(scope)) scope = ''; drawSide(); }
}, 60000);

// Fill in the bytes of attachments this device only has a stub for (a chat made on another device)
async function hydrateAttachments(c, only) {
  if (!sync.on || !c) return;
  const list = (only ? [only] : c.messages).flatMap(m => m.attachments || []);
  await Promise.all(list.filter(a => a.aid && !sync.bytesOf(a)).map(async (a) => {
    try {
      const r = await sync.api(`/chats/${c.id}/attachments/${a.aid}`);
      if (!r.ok) return;
      const j = await r.json();
      if (a.kind === 'image') a.dataUrl = j.body; else a.text = j.body;
    } catch { /* shown as a name only */ }
  }));
}
const attachmentSrc = (a) => a.dataUrl || (a.aid && chat ? `api/sync/chats/${chat.id}/attachments/${a.aid}/raw` : '');
// store.set and remove tell sync what changed
const rawSet = store.set.bind(store), rawRemove = store.remove.bind(store);
store.set = (key, value) => {
  const ok = rawSet(key, value);
  if (ok && sync.on) {
    if (key.startsWith('harness-chat:')) sync.pushChat(value);
    else if (SYNC_DATA.includes(key)) sync.pushData(key, value);
  }
  return ok;
};
store.remove = (key) => { rawRemove(key); if (key.startsWith('harness-chat:')) sync.dropChat(key.slice('harness-chat:'.length)); };

const PROJECTS_KEY = 'harness-projects';
const SKILLS_KEY = 'harness-skills';
const COMMANDS_KEY = 'harness-commands';
const SCHEDULES_KEY = 'harness-schedules';

let index = store.get(INDEX_KEY, []);   // [{id, title, updated, count, project}]
let projects = store.get(PROJECTS_KEY, []);   // [{id, name, color, instructions, repo, skills, created}]
let sharedProjects = [];   // projects other people shared with this account: [{id, name, color, instructions, owner, role}] (never stored in the browser)
const findProject = (id) => projects.find(p => p.id === id) || sharedProjects.find(p => p.id === id);
let skills = store.get(SKILLS_KEY, []);       // [{id, name, description, body}]
let commands = store.get(COMMANDS_KEY, []);   // [{id, name, description, body, model, effort}]
let schedules = store.get(SCHEDULES_KEY, []); // [{id, name, prompt, repeat, next, target, project, last}]
const unseen = new Set();                // chats that finished a reply while not open
const cache = new Map();                 // id -> chat
let chat = null;                         // the open chat
const running = new Map();               // chat id -> { controller, reply }
let toolInfo = null;                     // MCP servers and tool definitions (GET /ui/api/tools)

function newChatObject() {
  return { id: uid(), title: '', created: Date.now(), updated: Date.now(), system: '', notes: '', messages: [] };
}

function loadChat(id) {
  if (cache.has(id)) return cache.get(id);
  const c = store.get(CHAT_KEY(id), null);
  if (c) { clearStaleStreams(c); cache.set(id, c); }
  return c;
}

// A reply saved while it was still arriving belongs to a page that has gone (it was
// closed, reloaded or crashed): nothing is streaming it any more. Left as it is, its
// thinking animation would play forever and its Stop button would do nothing. What
// arrived is kept and the reply is marked as cut off.
function clearStaleStreams(c) {
  let changed = false;
  for (const m of c.messages || []) {
    if (m.role !== 'assistant' || !m.streaming) continue;
    changed = true;
    m.streaming = false;
    for (const r of m.rounds || []) for (const call of r.calls || []) if (call.result == null) { call.result = 'Cut off before this tool finished.'; call.isError = true; }
    delete m.joinText; delete m.reasoningRound; delete m.reasoningCut;
    if (m.trace) { delete m.trace.toolsRunning; m.trace.done = m.trace.done ?? Date.now() - (m.trace.start || Date.now()); }
    const note = m.trace?.error ? `cut off: ${m.trace.error}` : 'cut off when the page closed';
    m.content = m.content ? `${m.content}\n\n*(${note})*` : `*(${note})*`;
    m.cost = computeCost(m);
  }
  if (changed) { try { saveChat(c, { touch: false }); } catch {} }
  return changed;
}

function saveChat(c, { touch = true } = {}) {
  if (c.deleted) return; // a reply that ends after its chat was deleted
  if (touch) c.updated = Date.now();
  cache.set(c.id, c);
  // an empty chat isn't listed until something is in it
  if (!c.messages.length && !c.system && !c.notes && !c.repo && !c.github && !c.skills?.length) return;
  store.set(CHAT_KEY(c.id), c);
  const entry = { id: c.id, title: chatTitle(c), updated: c.updated, count: c.messages.length, project: c.project || undefined, caches: c.caches, ...(c.sharedFrom ? { sharedFrom: c.sharedFrom, sharedRole: c.sharedRole } : {}) };
  const i = index.findIndex(e => e.id === c.id);
  if (i >= 0) index[i] = entry; else index.push(entry);
  index.sort((a, b) => b.updated - a.updated);
  store.set(INDEX_KEY, index);
}

function deleteChat(id) {
  const c = cache.get(id);
  if (c?.sharedFrom || index.find(e => e.id === id)?.sharedFrom) return toast('A shared chat can only be deleted by the person who owns it.');
  if (c) c.deleted = true;
  running.get(id)?.controller.abort();
  index = index.filter(e => e.id !== id);
  cache.delete(id);
  store.remove(CHAT_KEY(id));
  store.set(INDEX_KEY, index);
  if (chat?.id === id) {
    if (speech.current && c?.messages.some(m => m.id === speech.current)) speech.stop();
    chat = null; // so opening the next chat doesn't save this one's draft back
    openChat(index[0]?.id);
  } else drawList();
}

function deleteAllChats() {
  for (const { controller } of running.values()) controller.abort();
  for (const e of index) store.remove(CHAT_KEY(e.id));
  for (const c of cache.values()) c.deleted = true;
  speech.stop();
  index = [];
  cache.clear();
  store.set(INDEX_KEY, index);
  chat = null;
  openChat(null);
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
const PREF_FIELDS = ['maxTokens', 'temperature', 'stream', 'timeoutFirst', 'timeoutStall', 'speakClear', 'sttEngine', 'sttLang', 'autoSend', 'ttsEngine', 'voice', 'serverModel', 'serverVoice', 'rate', 'pitch', 'volume', 'autoSpeak', 'handsFree', 'maxToolRounds', 'autoName', 'autoScroll', 'shellInRepo'];
const prefs = store.get(PREF_KEY, {});
// carry over the old page's toolbar
for (const id of ['maxTokens', 'temperature']) {
  try { const v = localStorage.getItem(`harness-chat-${id}`); if (v !== null && prefs[id] === undefined) prefs[id] = v; } catch {}
}
// The model box used to pin every chat; it is per chat now ("One model directly")
delete prefs.model;
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
    if (id === 'handsFree') drawHandsFree();
    if (id === 'autoSpeak' && !el.checked) speech.stop();
    if (id === 'ttsEngine') { speech.stop(); drawEngine(); }
    if (id === 'sttEngine') { drawEngine(); if (dictation.want) { dictation.stop(); dictation.start(); } }
    if (id === 'serverModel') { speech.stop(); drawServerVoices(); prefs.serverVoice = $('serverVoice').value; store.set(PREF_KEY, prefs); drawEngine(); }
    // the shell changes the tool list, so the panels and the repo note follow it
    if (id === 'shellInRepo') { drawRepo(); drawKit(); drawTools(); }
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
// About 4 characters a token, the Interceptor's own rule (ui/tokens.js)
const approxTokens = (chars) => Math.max(0, Math.round(chars / 4));
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
// Sidebar: projects, scheduled messages and recent chats, with live status
// ---------------------------------------------------------------------------
const COLORS = ['#8b6cff', '#ff5fa2', '#ffb547', '#3fd0ff', '#34d399', '#f87171', '#a3e635', '#c084fc'];
let scope = store.get('harness-chat-scope', '');   // '' = every chat, else a project id
if (scope && !projects.some(p => p.id === scope) && !(sharedProjects.length && findProject(scope))) scope = '';
const sideOpen = store.get('harness-side-sections', { projects: true, scheduled: true, recent: true });

// The chats panel folds away to a button in the top bar; the choice is kept
const narrow = () => matchMedia('(max-width: 760px)').matches;
let panelOpen = store.get('harness-side-open', true);
function setSide(open) {
  panelOpen = !!open;
  $('app').classList.toggle('side-open', panelOpen);
  $('toggleSide').classList.toggle('on', panelOpen);
  $('toggleSide').setAttribute('aria-expanded', String(panelOpen));
  $('toggleSide').title = panelOpen ? 'Hide chats' : 'Show chats';
  // a folded panel is still in the page, so keep it out of the tab order
  $('side').inert = !panelOpen;
  store.set('harness-side-open', panelOpen);
}

const projectOf = (c) => (c?.project ? findProject(c.project) : null);
const saveProjects = () => store.set(PROJECTS_KEY, projects);
const saveSkills = () => store.set(SKILLS_KEY, skills);
const saveSchedules = () => store.set(SCHEDULES_KEY, schedules);
function setScope(id) {
  scope = id || '';
  store.set('harness-chat-scope', scope);
  drawSide();
}

// "4m", "3h", "2d", or a date
function shortAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// What a running reply is doing, in a couple of words, for the sidebar
function liveStatus(id) {
  const r = running.get(id);
  if (!r) return '';
  const m = r.reply, tr = m.trace || {};
  if (tr.toolsRunning) {
    const call = (m.rounds || []).flatMap(x => x.calls).find(x => x.result == null);
    return call ? `tool · ${toolLabel(call.name)[1]}` : 'using tools';
  }
  if (tr.firstToken != null) {
    // tokens the provider has counted so far, else the text that has arrived
    const out = Tokens.usage(tr.usage)?.output ?? approxTokens(tr.textChars || 0);
    return `writing · ${fmtTok(out)}${Tokens.usage(tr.usage) ? '' : '~'}`;
  }
  if (tr.answered) return 'thinking';
  if (tr.routed) return 'waiting';
  return 'routing';
}

function visibleChats() {
  const q = $('search').value.trim().toLowerCase();
  return index.filter(e => (!scope || e.project === scope) && (!q || e.title.toLowerCase().includes(q) ||
    (loadChat(e.id)?.messages || []).some(m => String(m.content).toLowerCase().includes(q))));
}

function drawList() {
  drawProjects();
  const rows = visibleChats();
  const p = findProject(scope);
  $('chatsHead').textContent = p ? p.name : 'Recent';
  $('clearScope').hidden = !p;
  $('chatList').innerHTML = rows.map(e => {
    const proj = !scope && e.project ? findProject(e.project) : null;
    const live = running.has(e.id);
    return `<li data-id="${e.id}" class="${e.id === chat?.id ? 'active' : ''}${live ? ' live' : ''}${unseen.has(e.id) ? ' unseen' : ''}" title="${esc(e.title)}${proj ? ` · ${esc(proj.name)}` : ''}">
      ${proj ? `<i class="pdot" style="background:${proj.color}"></i>` : ''}
      <span class="ct">${esc(e.title)}</span>
      <span class="when">${live ? `<span class="busy"></span><span class="ls">${esc(liveStatus(e.id))}</span>` : shortAgo(e.updated)}</span>
      <button class="del" data-del="${e.id}" title="Delete chat" aria-label="Delete chat">${ICONS.x}</button></li>`;
  }).join('') || `<li class="muted small empty-row">${$('search').value.trim() ? 'No chats match.' : p ? 'No chats in this project yet. New chat starts one here.' : 'No saved chats yet.'}</li>`;
}

// Only the status words change while replies run, so update them in place
function drawLiveStatus() {
  for (const li of $('chatList').querySelectorAll('li.live')) {
    const ls = li.querySelector('.ls');
    if (ls) ls.textContent = liveStatus(li.dataset.id);
  }
}

function drawProjects() {
  const counts = {}, live = {};
  for (const e of index) if (e.project) { counts[e.project] = (counts[e.project] || 0) + 1; if (running.has(e.id)) live[e.project] = true; }
  $('projectList').innerHTML = projects.map(p => `<li data-pid="${p.id}" class="${scope === p.id ? 'active' : ''}" title="${esc(p.instructions?.slice(0, 200) || p.name)}">
      <i class="pdot" style="background:${p.color}"></i><span class="ct">${esc(p.name)}</span>
      ${live[p.id] ? '<span class="busy" title="A chat in this project is replying"></span>' : ''}<span class="when">${counts[p.id] || 0}</span>
      <button class="del edit" data-edit="${p.id}" title="Project settings" aria-label="Project settings">${ICONS.gear}</button></li>`).join('')
    || (sharedProjects.length ? '' : '<li class="muted small empty-row" title="Group chats with shared instructions, skills and a repo">No projects</li>');
  $('projectList').innerHTML += sharedProjects.map(p => `<li data-pid="${esc(p.id)}" class="shared${scope === p.id ? ' active' : ''}" title="${esc(`Shared by ${p.owner}, you can ${p.role === 'edit' ? 'edit' : 'view'} it`)}">
      <i class="pdot" style="background:${esc(p.color || COLORS[0])}"></i><span class="ct">${esc(p.name)}</span>
      <span class="when share-tag">${esc(p.owner)}</span>
      ${p.role === 'edit' ? `<button class="del edit" data-edit="${esc(p.id)}" title="Shared project settings" aria-label="Shared project settings">${ICONS.gear}</button>` : ''}</li>`).join('');
}

function drawSchedules() {
  const list = [...schedules].sort((a, b) => (a.next || Infinity) - (b.next || Infinity));
  $('schedList').innerHTML = list.map(s => {
    const when = s.next ? (s.next - Date.now() < 86400000 ? new Date(s.next).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : new Date(s.next).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })) : 'done';
    return `<li data-sid="${s.id}" title="${esc(s.prompt)}">${ICONS.clock}<span class="ct">${esc(s.name || s.prompt)}</span><span class="when">${s.repeat !== 'once' ? '↻ ' : ''}${esc(when)}</span></li>`;
  }).join('') || '<li class="muted small empty-row" title="Send a message on a timer, once or on repeat">Nothing scheduled</li>';
}

function drawSide() {
  for (const sec of document.querySelectorAll('.side-sec')) sec.classList.toggle('closed', sideOpen[sec.dataset.sec] === false);
  drawSchedules();
  drawList();
  drawProjectBits();
}

$('chatList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const entry = index.find(x => x.id === del.dataset.del);
    if (await ui.confirm(`Delete “${entry?.title || 'this chat'}”?`)) deleteChat(del.dataset.del);
    return;
  }
  const li = e.target.closest('li[data-id]');
  if (li) { openChat(li.dataset.id); if (narrow()) setSide(false); }
});
$('projectList').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { e.stopPropagation(); openProjectDialog(edit.dataset.edit); return; }
  const li = e.target.closest('li[data-pid]');
  if (li) setScope(scope === li.dataset.pid ? '' : li.dataset.pid);
});
$('schedList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-sid]');
  if (li) openScheduleDialog(li.dataset.sid);
});
$('clearScope').addEventListener('click', () => setScope(''));
for (const btn of document.querySelectorAll('.sec-toggle')) {
  btn.addEventListener('click', () => {
    const sec = btn.closest('.side-sec');
    sideOpen[sec.dataset.sec] = sec.classList.contains('closed');
    store.set('harness-side-sections', sideOpen);
    sec.classList.toggle('closed');
  });
}
$('search').addEventListener('input', drawList);

// Each chat has its own address, chat.html#chat=ID. Opening a chat pushes it (so Back/Forward walk through the
// chats you looked at); the first chat of a page load replaces the entry instead.
const chatHash = id => `#chat=${encodeURIComponent(id)}`;
let urlFresh = true;
function syncUrl() {
  if (!chat || location.hash === chatHash(chat.id)) { urlFresh = false; return; }
  try { history[urlFresh ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + chatHash(chat.id)); } catch {}
  urlFresh = false;
}
window.addEventListener('popstate', () => {
  const id = decodeURIComponent((location.hash.match(/^#chat=(.+)$/) || [])[1] || '');
  if (id && id !== chat?.id && index.some(e => e.id === id)) openChat(id, { fromUrl: true });
});

function openChat(id, { fromUrl = false } = {}) {
  if (chat && chat.id !== id) saveDraft();
  chat = (id && loadChat(id)) || newChatObject();
  if (!id && scope) chat.project = scope; // a new chat starts in the project being shown
  const sp = !id && sharedProjects.find(x => x.id === scope);
  if (sp) { if (sp.role === 'edit') Object.assign(chat, { sharedFrom: sp.owner, sharedRole: 'edit' }); else delete chat.project; } // a view-only project takes no new chats
  if (!id && !chat.project) { try { applyQuick(chat, localStorage.getItem(NEW_ROUTE_KEY)); } catch {} }
  cache.set(chat.id, chat);
  unseen.delete(chat.id);
  $('title').value = chat.title;
  $('title').placeholder = chatTitle(chat);
  $('system').value = chat.system || '';
  $('notes').value = chat.notes || '';
  $('input').value = chat.draft || '';
  if (typeof hideSlash === 'function') hideSlash();
  pending = chat.pendingAttachments || [];
  drawChips(); autoGrow(); drawContextSize(); drawRepo(); drawGithub(); drawRoute(); drawTools(); drawEffort();
  drawList();
  drawProjectBits();
  drawLog();
  busy(running.has(chat.id));
  drawQueue();
  drawAdvisor();
  try { localStorage.setItem('harness-chat-open', chat.id); } catch {}
  if (!fromUrl) syncUrl();
  $('input').focus();
}

function saveDraft() {
  if (!chat) return;
  chat.draft = $('input').value;
  chat.pendingAttachments = pending;
  if (chat.messages.length) saveChat(chat, { touch: false });
}

function stepChat(dir) {
  const list = visibleChats();
  if (!list.length) return;
  const i = list.findIndex(e => e.id === chat?.id);
  const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? -1 : i) + dir))];
  if (next) openChat(next.id);
}

$('newChat').addEventListener('click', () => { openChat(null); if (narrow()) setSide(false); });
$('deleteChat').addEventListener('click', async () => {
  if (!index.some(e => e.id === chat.id)) {
    // nothing saved yet: just clear what's typed
    if (!$('input').value && !pending.length) return toast('Nothing to delete yet.');
    $('input').value = ''; pending = []; drawChips(); autoGrow();
    return;
  }
  if (await ui.confirm(`Delete “${chatTitle(chat)}”? This can't be undone.`)) deleteChat(chat.id);
});
$('deleteAll').addEventListener('click', async () => {
  if (!index.length) return toast('No saved chats to delete.');
  if (await ui.confirm(`Delete all ${index.length} saved chat${index.length === 1 ? '' : 's'} in this browser? This can't be undone. (Export all chats first to keep a copy.)`)) deleteAllChats();
});
// The pages bar is folded into a menu on this page: the brand and its orb live beside the replies
function setPagesMenu(on) {
  document.body.classList.toggle('menu-open', on);
  $('pagesMenu').setAttribute('aria-expanded', String(on));
}
$('pagesMenu').addEventListener('click', (e) => { e.stopPropagation(); setPagesMenu(!document.body.classList.contains('menu-open')); });
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('menu-open') && (e.target.closest('.top a') || !e.target.closest('.top'))) setPagesMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('menu-open')) { setPagesMenu(false); $('pagesMenu').focus(); e.stopImmediatePropagation(); }
}, true);
$('toggleSide').addEventListener('click', () => setSide(!$('app').classList.contains('side-open')));
$('title').addEventListener('change', () => { chat.title = $('title').value.trim(); saveChat(chat, { touch: false }); drawList(); });
$('system').addEventListener('change', () => { chat.system = $('system').value; saveChat(chat); drawList(); drawContextSize(); });
$('notes').addEventListener('change', () => { chat.notes = $('notes').value; saveChat(chat); drawList(); drawContextSize(); });
$('system').addEventListener('input', drawContextSize);
$('notes').addEventListener('input', drawContextSize);

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
const SUGGESTIONS = [
  'Explain embeddings like I’m twelve',
  'Write a haiku about routing tokens',
  'Plan a weekend project with a Raspberry Pi',
  'Review this function for bugs',
  'What is the difference between a model and a router?',
  'Give me three names for a cosy café',
];
const suggestionPicks = new Map(); // chat id -> its three suggestions, so a redraw doesn't reshuffle them
function emptyState() {
  const p = projectOf(chat);
  if (!suggestionPicks.has(chat.id)) suggestionPicks.set(chat.id, [...SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 3));
  const picks = suggestionPicks.get(chat.id);
  return `<div class="empty"><div class="orb" aria-hidden="true"><i></i><i></i><i></i></div>
    <h2>${p ? `New chat in ${esc(p.name)}` : 'What shall we explore?'}</h2>
    
    ${quickPicker()}
    <div class="suggest">${picks.map(t => `<button type="button" class="chip-btn" data-suggest="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <p class="small tip">Drop files, dictate, or type <kbd>/</kbd> for skills and tools.</p>
    ${hostedNoFolders() && !ghOf(chat) ? '<p class="small tip">To ask about your code, attach a GitHub repo under Options &gt; Tools.</p>' : ''}</div>`;
}

// Quick pick on a new chat: a strategy, or one model directly. Outside projects
// the last pick is remembered for the next new chat.
const NEW_ROUTE_KEY = 'harness-new-chat-route';
let gatewayModels = [];  // GET api/models
let quickStats = {};     // GET api/model-stats: quality and price per model, for the picker's labels
function quickValue(c) {
  const own = c.route && c.route !== 'project' ? c.route : (projectOf(c) ? 'project' : 'default');
  return own === 'model' ? (c.model ? `m:${c.model}` : 'default') : own;
}
function quickStat(m) {
  const s = quickStats[m];
  if (!s) return '';
  const price = s.blended === null || s.blended === undefined ? null : s.blended === 0 ? 'free' : `$${s.blended < 0.1 ? +s.blended.toPrecision(2) : +s.blended.toFixed(2)}/M`;
  const bits = [s.quality !== null && s.quality !== undefined && `quality ${Math.round(s.quality)}`, price].filter(Boolean);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}
function quickNote(c) {
  const r = routeOf(c);
  if (r.model) return 'Every message goes to this model.';
  if (r.auto) return 'Picks the strategy that fits each message.';
  const tiers = (r.profile ? r.profile.tiers : strategies.tiers) || [];
  return `The Router picks ${tiers.length ? `one of ${tiers.length + 2} tiers` : 'strong or weak'}. Effort leans it.`;
}
function quickPicker() {
  const p = projectOf(chat);
  const v = quickValue(chat);
  const opt = (val, label) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(label)}</option>`;
  const models = [...new Set([...gatewayModels, ...(v.startsWith('m:') ? [v.slice(2)] : [])])];
  const missing = v.startsWith('p:') && !strategies.profiles.some(x => `p:${x.id}` === v);
  return `<div class="quick-pick"><label>Answer with <select id="quickRoute" aria-label="Strategy or model for this chat">
      <optgroup label="Strategies">${p ? opt('project', `Same as the project (${routeLabel(routeOf({ project: chat.project }))})`) : ''}${opt('default', 'Default strategy')}${opt('auto', 'Auto (picks a strategy per message)')}${strategies.profiles.map(x => opt(`p:${x.id}`, x.name)).join('')}${missing ? opt(v, `${v.slice(2)} (deleted)`) : ''}</optgroup>
      ${models.length ? `<optgroup label="One model directly">${models.map(m => opt(`m:${m}`, m + quickStat(m))).join('')}</optgroup>` : ''}
    </select></label><small id="quickNote">${esc(quickNote(chat))}</small></div>`;
}
function applyQuick(c, v) {
  if (!v) return;
  if (v.startsWith('m:')) { c.route = 'model'; c.model = v.slice(2); } else if (v === 'project') delete c.route; else c.route = v;
}
// A strategy list or model list that arrives late redraws an empty chat's picker
const redrawQuick = () => { if (chat && !chat.messages.length && $('quickRoute')) drawLog(); };

// Something to read while the model gets going; turns over every few seconds
const THINKING = ['Wandering the latent space…', 'Herding tokens…', 'Consulting the embeddings…', 'Asking the router nicely…',
  'Warming up the attention heads…', 'Untangling the context…', 'Sampling the good words…', 'Following the gradient…',
  'Polishing a fresh thought…', 'Lining up the vectors…', 'Brewing a reply…', 'Rounding up the logits…'];
function thinkingHtml(m) {
  const elapsed = Date.now() - (m.trace?.start || m.time || Date.now());
  const seed = [...m.id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  const phrase = THINKING[(seed + Math.floor(elapsed / 2600)) % THINKING.length];
  // negative delays keep the animations running smoothly across redraws
  const lag = `animation-delay:-${elapsed % 2200}ms`;
  return `<div class="thinking"><span class="spark" style="animation-delay:-${elapsed % 1600}ms"><i></i><i></i><i></i></span><span class="shimmer" style="${lag}">${phrase}</span></div>`;
}

function attachmentsHtml(list) {
  if (!list?.length) return '';
  return `<div class="attach-list">${list.map(a => a.kind === 'image'
    ? `<img src="${esc(attachmentSrc(a))}" alt="${esc(a.name)}" title="${esc(a.name)}">`
    : `<span class="chip"><span>📄 ${esc(a.name)}</span></span>`).join('')}</div>`;
}

// Why the Router picked this model, in a few words
function routeWhy(r) {
  if (!r) return '';
  const via = r.auto ? `Auto: ${r.auto.how === 'default' ? 'default strategy' : r.profile}, ${r.auto.why}` : '';
  const on = r.auto ? ` (${via})` : r.profile && !String(r.reason || '').includes(r.profile) ? ` (strategy: ${r.profile})` : '';
  if (r.reason) return r.reason + on;
  if (r.routerError) return 'Router down' + on;
  const effort = r.effort ? `, effort ${r.effort > 0 ? '+' : ''}${r.effort}` : '';
  return r.winRate != null ? `${r.tier ? `${r.tier} tier: ` : ''}win rate ${r.winRate} vs threshold ${r.threshold}${effort}${on}` : on.trim();
}

function traceHtml(m) {
  const tr = m.trace;
  if (!tr) return '';
  const steps = [];
  const now = Date.now();
  const live = m.streaming;
  const step = (cls, text, t) => steps.push({ cls, text, t });

  step('ok', 'Sent to the Interceptor', '');
  if (tr.routed) {
    const r = tr.routed;
    const why = r.reason || (r.routerError ? `Router down (${esc(r.routerError)}), used the fallback` : r.winRate != null ? `${r.tier ? `${r.tier} tier, ` : ''}strong win rate ${r.winRate} vs threshold ${r.threshold}${r.effort ? `, effort ${r.effort > 0 ? '+' : ''}${r.effort}` : ''}` : '');
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
    // what the provider counted, else the text that has arrived (marked ~)
    const u = Tokens.usage(tr.usage);
    const tok = u?.output ?? approxTokens(tr.textChars || 0);
    const secs = ((done ? tr.done : now - tr.start) - tr.firstToken) / 1000;
    const rate = secs > 0.2 && tok ? ` · ${(tok / secs).toFixed(0)} tok/s` : '';
    const why = tr.finish ? ` · stopped because ${tr.finish === 'length' ? 'it hit the output cap' : tr.finish === 'tool_calls' ? 'it asked for a tool' : tr.finish === 'stop' ? 'it was done' : tr.finish === 'content_filter' ? 'of the content filter' : tr.finish}` : '';
    step(done ? 'ok' : 'now', `${done ? 'Reply finished' : 'Writing'} · ${u ? '' : '~'}${tok ?? 0} tokens${rate}${done ? why : ''}`, `first token ${fmtMs(tr.firstToken)}`);
  } else if (live && tr.answered) {
    step('now', 'Waiting for the first token…', fmtMs(now - tr.start));
  }
  if (tr.droppedCalls) step('bad', `${tr.droppedCalls} tool call${tr.droppedCalls > 1 ? 's' : ''} arrived with no name and could not run`, '');
  if (tr.error) step('bad', esc(tr.error), '');
  const row = ({ cls, text, t }) => `<li class="${cls}"><span class="st">${cls === 'ok' ? '✓' : cls === 'bad' ? '✕' : ''}</span><span>${text}</span><span class="t">${t ?? ''}</span></li>`;
  const current = steps[steps.length - 1];
  const history = steps.slice(0, -1);
  return `<div class="trace-progress">${current ? `<div class="trace-current ${current.cls}"><span class="st">${current.cls === 'ok' ? '✓' : current.cls === 'bad' ? '✕' : ''}</span><span class="label">${current.text}</span><span class="t">${current.t ?? ''}</span></div>` : ''}
    ${history.length ? `<details class="trace-history" data-k="trace-history"><summary>Earlier steps (${history.length})</summary><ul class="trace">${history.map(row).join('')}</ul></details>` : ''}</div>`;
}

// "1,234 in · 567 out", with a ~ when the provider sent no counts and the
// numbers were worked out from the prompt and the reply
function replyUsageHtml(m) {
  const k = usageOf(m);
  if (!k) return '';
  const tilde = k.exact ? '' : '~';
  return `<span title="${k.exact ? 'Counted by the provider' : 'Estimated: the provider sent no counts, so this is about 4 characters a token'}">${tilde}${k.input.toLocaleString()} in · ${tilde}${k.output.toLocaleString()} out</span>`;
}

// Which model wrote a reply, always visible under it (the reason is in the tooltip)
function modelLabelHtml(m) {
  const model = replyModel(m);
  if (!model) return '<span class="name">Assistant</span>';
  const why = routeWhy(m.trace?.routed) || m.meta?.route;
  const asked = m.trace?.routed?.model;
  return `<span class="name model" title="${esc(`Written by ${model}${asked && asked !== model ? ` (routed to ${asked})` : ''}${why ? ` · ${why}` : ''}`)}"><code>${esc(model)}</code></span>`;
}

// Under a finished reply, one quiet "Details" row. Opened it shows the facts (route,
// time, tokens, cost) and, one level further in, the thinking, the tool calls and the
// routing steps. The Activity drawer lists every call too.
function metaHtml(m) {
  const tr = m.trace, meta = m.meta || {};
  const rounds = m.rounds || [];
  const calls = rounds.reduce((n, r) => n + r.calls.length, 0);
  const bits = [
    (routeWhy(tr?.routed) || meta.route) && esc(routeWhy(tr?.routed) || meta.route),
    m.turn?.command && `<span class="tag" title="Sent by the command /${esc(m.turn.command)}${turnNote(m.turn) ? `: ${esc(turnNote(m.turn))}` : ''}">/${esc(m.turn.command)}</span>`,
    tr?.answered?.fallbacks > 0 && `<span class="warn">${tr.answered.fallbacks} fallback${tr.answered.fallbacks > 1 ? 's' : ''}</span>`,
    (tr?.done ?? meta.ms) != null && fmtMs(tr?.done ?? meta.ms),
    replyUsageHtml(m),
    costHtml(m),
  ].filter(Boolean);
  const inner = [reasoningHtml(m), toolCallsHtml(rounds),
    tr ? `<details class="routing-steps" data-k="trace"><summary>Routing steps</summary>${traceHtml(m)}</details>` : ''].join('');
  if (!bits.length && !inner) return '';
  const hint = [m.reasoning && 'thinking', calls && `${calls} tool call${calls > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  const needsInput = rounds.some(r => r.calls.some(c => c.approval?.state === 'ask'));
  return `<details class="meta more" data-k="more"${needsInput ? ' open' : ''}><summary>Details${hint ? `<span class="hint-bits"> · ${hint}</span>` : ''}</summary>
    ${bits.length ? `<div class="facts">${bits.join(' · ')}</div>` : ''}${inner}</details>`;
}

// ---------------------------------------------------------------------------
// Token costs and context size, from the Gateway's prices (/ui/api/model-info)
// ---------------------------------------------------------------------------
let modelInfo = {};   // model name -> { maxInput, maxOutput, inputCost, outputCost, free }
const replyModel = (m) => m?.trace?.answered?.servedBy || m?.trace?.routed?.model || m?.meta?.model || '';
const fmtTok = (n) => n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
const fmtUsd = (n) => n === 0 ? '$0' : n < 0.0001 ? '<$0.0001' : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

// Tokens of anything one request or one reply reported, in one shape whatever
// the provider called its fields (ui/tokens.js): { input, output, cacheRead,
// cacheWrite, cost, exact }. A reply whose rounds reported counts is the sum of
// its rounds (runReply keeps that in tr.usageParts); anything the provider left
// out is filled from what did arrive, and marked inexact.
function usageOf(x) {
  const tr = x?.trace || {};
  const k = tr.usageParts ? { ...tr.usageParts } : Tokens.usage(tr.usage);
  if (!k) return null;
  // Some providers stream the text without ever counting it (an OpenAI stream
  // without include_usage). Then the prompt we sent and the text that arrived
  // are the best numbers there are, at about 4 characters a token.
  if (!k.input) { k.input = approxTokens(tr.sentChars ?? 0); k.exact = false; }
  if (!k.output && tr.textChars) { k.output = approxTokens(tr.textChars); k.exact = false; }
  return k;
}

// { usd, free, estimated } or null when the price isn't known. The provider's
// own figure wins (OpenRouter's usage.cost, LiteLLM's cost header); else the
// tokens times the Gateway's price list.
function computeCost(m) {
  const tr = m.trace || {};
  const k = usageOf(m);
  if (typeof k?.cost === 'number') return { usd: k.cost, free: k.cost === 0 };
  if (tr.headerCost > 0) return { usd: tr.headerCost, free: false };
  const info = modelInfo[replyModel(m)];
  if (info?.free) return { usd: 0, free: true };
  if (!info || info.inputCost == null || !k) return null;
  return { usd: Costs.rowCost(k, info).cost, free: false, estimated: !k.exact };
}
// A cost saved as null means the price wasn't known yet (the price list was still loading), so it is worked out again
const replyCost = (m) => (m.cost != null && !m.streaming ? m.cost : computeCost(m));

function costHtml(m) {
  const c = replyCost(m);
  if (!c) return '';
  if (c.free) return '<span class="cost free" title="This model is free to use">free</span>';
  return `<span class="cost" title="${c.estimated ? 'Worked out from the Gateway’s price list' : 'Reported by the provider'}">${c.estimated ? '≈ ' : ''}${fmtUsd(c.usd)}</span>`;
}

// Tokens the next request will send, counted where it is put together: every
// context block, the history with its attachments and tool calls, the tool
// schemas (however small) and the box. Images are noted separately: their size
// in tokens depends on the model.
function requestPrompt() {
  if (!chat) return { chars: 0, images: 0 };
  let images = 0;
  // a text attachment goes in as a <file> block
  const fileChars = (list) => (list || []).reduce((n, a) => (
    a.kind === 'image' ? n : n + `<file name="${a.name}">\n${a.text || ''}\n</file>`.length), 0);
  // a user message as it will be sent: a command's own message, then its file blocks
  const userChars = (m) => {
    const text = [m.turn?.command ? commandPrompt(m) : m.content,
      ...(m.attachments || []).filter(a => a.kind === 'text').map(f => `<file name="${f.name}">\n${f.text}\n</file>`)].filter(Boolean);
    return JSON.stringify(text).length;
  };
  // images are counted, not measured: their size in tokens depends on the model
  const countImages = (list) => { images += (list || []).filter(a => a.kind === 'image').length; };
  // what will be sent, not what is stored: a command's message, the attachments
  // written out as file blocks, and the tool calls and results of each round
  let chars = contextText(chat).length;
  for (const m of chat.messages) {
    if (m.role === 'user') { chars += userChars(m); countImages(m.attachments); }
    else if (m.role === 'assistant' && !m.streaming) {
      chars += assistantMessages(m, true).reduce((k, a) => k + JSON.stringify(a).length, 0);
    }
  }
  // the tool schemas go with every request, small ones included
  const tools = JSON.stringify(activeTools(chat));
  if (tools && tools !== '[]') chars += tools.length;
  return { chars: chars + fileChars(pending) + $('input').value.length, images };
}
function requestTokens() {
  return approxTokens(requestPrompt().chars);
}

// Header: tokens and cost so far in this chat, and how full the context is.
// Counts come from what each provider reported; a reply still arriving counts
// what it has reported so far, so the numbers move as it writes.
// countNext false keeps the last "next request" size: while a reply streams it
// can't change, and recounting the whole history 4 times a second is wasted work.
let nextTokens = null;
function drawStats(countNext = true) {
  const el = $('chatStats');
  if (!chat) return;
  const replies = chat.messages.filter(m => m.role === 'assistant');
  const sent = chat.messages.filter(m => m.role === 'user');
  let input = 0, output = 0, usd = 0, paid = 0, free = 0, unknown = 0, estimated = 0, requests = 0;
  for (const m of replies) {
    const k = usageOf(m);
    if (k) {
      requests++;
      input += k.input; output += k.output;
      if (!k.exact) estimated++;
    }
    const c = replyCost(m);
    if (!c) unknown++; else if (c.free) free++; else { paid++; usd += c.usd; }
  }
  const next = (countNext || nextTokens == null) ? (nextTokens = requestTokens()) : nextTokens;
  const model = routeOf(chat).model || replyModel(replies[replies.length - 1]);
  const max = modelInfo[model]?.maxInput;
  const lastSent = [...replies].reverse().map(usageOf).find(k => k?.input)?.input;
  if (!replies.length && !next) { el.innerHTML = ''; return; }
  const pct = max ? Math.min(100, Math.round(next / max * 100)) : null;
  const tilde = estimated ? '~' : '';
  const bits = [];
  if (input + output) bits.push(`<span title="${estimated ? `${estimated} of ${requests} request${requests === 1 ? '' : 's'} had no counts from the provider, so those are estimated` : 'Counted by the providers'}">${tilde}${fmtTok(input + output)} tokens</span>`);
  if (paid) bits.push(`<span>${fmtUsd(usd)}${unknown ? '+' : ''}</span>`);
  else if (free && !unknown) bits.push('<span class="ok">free</span>');
  bits.push(max
    ? `<span class="ctx-text">context ${fmtTok(next)} / ${fmtTok(max)}</span><span class="meter${pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : ''}"><i style="width:${Math.max(2, pct)}%"></i></span>`
    : `<span class="ctx-text">context ≈ ${fmtTok(next)}</span>`);
  el.innerHTML = bits.join('');
  el.title = [
    `This chat: ${tilde}${input.toLocaleString()} tokens in, ${tilde}${output.toLocaleString()} out over ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}${estimated ? ` (${estimated} estimated: the provider sent no counts)` : ''}.`,
    `You sent ${sent.length} message${sent.length === 1 ? '' : 's'}; each reply re-sends the whole history, so input tokens grow faster than the chat does.`,
    `Cost: ${fmtUsd(usd)} for ${paid} paid repl${paid === 1 ? 'y' : 'ies'}${free ? `, ${free} free` : ''}${unknown ? `, ${unknown} with no known price` : ''}.`,
    `Next request: about ${next.toLocaleString()} tokens${max ? ` of ${model}'s ${max.toLocaleString()} (${pct}%)` : model ? ` (no context size known for ${model})` : ''}.`,
    lastSent ? `The last reply was sent ${lastSent.toLocaleString()} tokens.` : '',
  ].filter(Boolean).join('\n');
}

// After a wake from sleep the Gateway (and OpenRouter's list) can still be
// loading; model-info then answers with what config.yaml knows, without prices.
// Ask again a few times so the prices appear without a reload.
let modelInfoTries = 0;
function loadModelInfo() {
  fetch('api/model-info').then(r => r.json()).then((j) => {
    modelInfo = j.models || {};
    const complete = j.source === 'gateway' && (!j.openrouter || j.openrouter.ok);
    if (!complete && modelInfoTries < 6) setTimeout(loadModelInfo, 5000 * 2 ** modelInfoTries++);
    else if (complete) modelInfoTries = 0;
    if (chat && !running.has(chat.id)) drawLog(); else drawStats();
  }).catch(() => { if (modelInfoTries < 6) setTimeout(loadModelInfo, 5000 * 2 ** modelInfoTries++); });
}

const fresh = (m) => m.time && Date.now() - m.time < 1500;
function messageHtml(m, i, list) {
  const lastAssistant = m.role === 'assistant' && i === list.length - 1;
  const speaking = speech.current === m.id;
  if (m.role === 'user') {
    return `<div class="msg user${fresh(m) ? ' enter' : ''}" data-id="${m.id}"><div class="who"><span class="name">You</span><span class="actions">
        <button data-act="copy" title="Copy">${ICONS.copy}</button>
        <button data-act="edit" title="Edit and resend">${ICONS.edit}</button>
        <button data-act="resend" title="Send this again (replies after it are replaced)">${ICONS.retry}</button></span></div>
      ${attachmentsHtml(m.attachments)}${m.content || m.turn?.command ? `<div class="bubble">${m.turn?.command ? `<code>/${esc(m.turn.command)}</code>${m.content ? ` ${esc(m.content)}` : ''}` : esc(m.content)}</div>` : ''}</div>`;
  }
  if (m.role === 'error') {
    return `<div class="msg error" data-id="${m.id}"><div class="who">Error<span class="actions">
        ${i === list.length - 1 ? `<button data-act="retry" title="Try again">${ICONS.retry} Retry</button>` : ''}
        <button data-act="copy" title="Copy">${ICONS.copy}</button></span></div>
      <div class="bubble">${esc(m.content)}</div>${m.hint ? `<div class="hint">${esc(m.hint)}</div>` : ''}${m.trace ? `<div class="meta"><details open><summary>What happened</summary>${traceHtml(m)}</details></div>` : ''}</div>`;
  }
  return `<div class="msg assistant${m.streaming ? ' streaming' : ''}${lastAssistant ? ' latest' : ''}${fresh(m) ? ' enter' : ''}" data-id="${m.id}"><span class="orb-av" aria-hidden="true"><i></i><i></i><i></i></span><div class="who">${modelLabelHtml(m)}<span class="actions">
      ${m.streaming ? `<button data-act="stop" class="stop" title="Stop this reply (Esc)">${ICONS.stop} Stop</button>` : ''}
      <button data-act="copy" title="Copy as Markdown">${ICONS.copy}</button>
      <button data-act="speak" title="${speaking ? 'Stop reading' : 'Read aloud'}" class="${speaking ? 'speaking' : ''}">${speaking ? ICONS.stop : ICONS.speak}</button>
      ${lastAssistant && !m.streaming ? `<button data-act="retry" title="Regenerate">${ICONS.retry}</button>` : ''}</span></div>
    <div class="bubble${m.streaming ? ' working' : ''}"${m.streaming ? ` style="--spin-delay:-${(Date.now() - m.time) % 4000}ms"` : ''}><div class="live-trace">${m.streaming ? traceHtml(m) : ''}</div>
      ${m.streaming && !m.content && !(m.rounds || []).length && !m.reasoning ? thinkingHtml(m) : ''}
      ${replyBodyHtml(m)}
      <div class="meta-wrap">${m.streaming ? '' : metaHtml(m)}</div></div></div>`;
}

// What the model thought first, when the provider sends it back. It stays in
// the chat and goes above the tool calls it led to, but is never sent back to
// the model as part of the conversation.
const REASONING_SHOWN = 20000;
function isThinking(m) {
  const rounds = m.rounds || [];
  const since = m.content.slice(rounds.length ? rounds[rounds.length - 1].end : 0);
  return !!m.streaming && !since.trim() && rounds.every(r => r.calls.every(c => c.result != null));
}
function reasoningHtml(m) {
  const text = m.reasoning || '';
  if (!text) return '';
  const shown = text.length > REASONING_SHOWN ? `${text.slice(0, REASONING_SHOWN)}\n… (${(text.length - REASONING_SHOWN).toLocaleString()} more characters)` : text;
  // the dots hop only while the model is thinking: not once text or a tool call has followed
  const live = isThinking(m);
  return `<details class="reasoning${live ? ' live' : ''}" data-k="reasoning"><summary>
      <span class="spark"><i></i><i></i><i></i></span><span>${live ? 'Thinking' : 'Thought'}</span>
      <span class="t">${text.length.toLocaleString()} characters</span></summary><pre>${esc(shown)}</pre></details>`;
}

// Reply text with all tool calls grouped where the first round happened
function replyBodyHtml(m) {
  const rounds = m.rounds || [];
  const last = rounds.length ? rounds[rounds.length - 1].end : 0;
  const rest = m.content.slice(last);
  // a finished reply keeps its thinking and tool calls in the Details under it
  const fold = !m.streaming;
  let html = fold ? '' : reasoningHtml(m), from = 0;
  let toolsAdded = fold;
  rounds.forEach((r) => {
    const text = m.content.slice(from, r.end);
    if (text.trim()) html += `<div class="md">${render(text)}</div>`;
    if (!toolsAdded) {
      html += toolCallsHtml(rounds);
      toolsAdded = true;
    }
    from = r.end;
  });
  const empty = !m.content && !rounds.length && !m.streaming;
  return `${html}<div class="md${m.streaming && rest ? ' cursor' : ''}">${rest.trim() ? render(rest) : empty ? '<span class="muted">(empty reply)</span>' : ''}</div>`;
}

// "mcp__github__search_code" -> ["github", "search_code"]; "repo_read_file" -> ["repo", "read_file"]
function toolLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return [m[1], m[2]];
  if (name.startsWith('repo_')) return ['repo', name.slice(5)];
  if (name.startsWith('github_')) return ['github', name.slice(7)];
  if (name === 'run_command') return ['shell', name];
  return ['', name];
}

function argsSummary(args) {
  let text = args || '';
  try {
    const j = JSON.parse(args);
    text = Object.entries(j).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  } catch {}
  return text.length > 120 ? text.slice(0, 117) + '…' : text;
}

function prettyArgs(args) {
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args || ''; }
}

const SHOW_RESULT = 6000;
function toolCallsHtml(rounds) {
  const calls = rounds.flatMap((r, k) => r.calls.map((call, j) => ({ call, key: `tool-${k}-${j}` })));
  if (!calls.length) return '';
  const needsInput = calls.some(({ call }) => call.approval?.state === 'ask');
  const state = calls.some(({ call }) => call.result == null) ? 'now' : calls.some(({ call }) => call.isError) ? 'bad' : 'ok';
  return `<details class="tool-calls ${state}${needsInput ? ' needs-input' : ''}" data-k="tools"${needsInput ? ' open' : ''}><summary><span class="st">${state === 'ok' ? '✓' : state === 'bad' ? '✕' : ''}</span>
      <span>Tool calls (${calls.length})</span>${needsInput ? '<span class="approval-needed">Needs your input: allow or decline</span>' : ''}</summary><div class="tool-list">${calls.map(({ call: c, key }) => {
    const [src, name] = toolLabel(c.name);
    const state = c.result == null ? 'now' : c.isError ? 'bad' : 'ok';
    const result = c.result == null ? '' : c.result.length > SHOW_RESULT ? `${c.result.slice(0, SHOW_RESULT)}\n… (${(c.result.length - SHOW_RESULT).toLocaleString()} more characters sent to the model)` : c.result;
    const ap = c.approval;
    const asked = ap?.state === 'ask';
    const approve = asked ? `<div class="approve"><span>${esc(ap.reason || 'The command guard is unsure about this command.')}</span>
        <button type="button" data-approve="allow" data-call="${esc(c.id)}">Allow</button><button type="button" data-approve="decline" data-call="${esc(c.id)}">Decline</button></div>`
      : ap ? `<div class="verdict ${ap.state === 'allowed' ? 'ok' : 'bad'}">${ap.state === 'allowed' ? 'You allowed it' : 'You declined it'}${ap.reason ? ` · ${esc(ap.reason)}` : ''}</div>` : '';
    return `<details class="tool-call ${state}" data-k="${key}"${asked ? ' open' : ''}><summary><span class="st">${state === 'ok' ? '✓' : state === 'bad' ? '✕' : ''}</span>
        ${src ? `<span class="src">${esc(src)}</span>` : ''}<code>${esc(name)}</code><span class="args">${esc(argsSummary(c.arguments))}</span>
        <span class="t">${c.ms != null ? fmtMs(c.ms) : asked ? 'waiting for you' : state === 'now' ? 'running…' : ''}</span></summary>
      <div class="io"><b>Input</b><pre>${esc(prettyArgs(c.arguments))}</pre>${approve}${c.result != null ? `<b>Result</b><pre class="out">${esc(result)}</pre>` : ''}</div></details>`;
  }).join('')}</div></details>`;
}

// Whether the conversation follows the newest text. Scrolling up leaves it where
// you put it, even mid-reply; scrolling back to the end (or pressing the button
// that appears while you are up there) follows again.
const NEAR_BOTTOM = 60;   // how close to the end counts as being at the end
let stickToBottom = true;
let jumpedAway = false;   // you scrolled up during a reply and haven't come back
const atBottom = () => {
  const log = $('log');
  return log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
};
function drawJumpDown() {
  const b = $('jumpDown');
  const away = !atBottom();
  b.hidden = !away;
  b.classList.toggle('new', away && jumpedAway);
}
$('log').addEventListener('scroll', () => {
  stickToBottom = atBottom();
  if (stickToBottom) jumpedAway = false;
  drawJumpDown();
});
$('jumpDown').addEventListener('click', () => {
  stickToBottom = true;
  jumpedAway = false;
  $('log').scrollTop = $('log').scrollHeight;
  drawJumpDown();
  $('input').focus();
});

function drawLog() {
  const log = $('log');
  // a chat that is redrawn from scratch (a new message arrived) follows the end again
  const follow = stickToBottom || !jumpedAway;
  log.innerHTML = chat.messages.length ? chat.messages.map(messageHtml).join('') : emptyState();
  stickToBottom = follow;
  jumpedAway = false;
  if (follow) log.scrollTop = log.scrollHeight;
  drawJumpDown();
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
      if (el) patch(el, html);
      else { drawLog(); followThinking(); }
    }
    dirty.clear();
    if (stickToBottom && $('autoScroll').checked) $('log').scrollTop = $('log').scrollHeight;
    else if (!atBottom()) jumpedAway = true;
    drawJumpDown();
  });
}
// A thinking pane that is open keeps its newest text in view while the reply
// streams in, whatever the chat is doing. A pane you scrolled up in stays where
// you put it, so reading an earlier thought isn't undone by the next one.
function followThinking(root) {
  const scope = root || $('log');
  for (const pre of scope.querySelectorAll('.reasoning[open] > pre')) {
    if (pre.dataset.hold === '1') continue;
    pre.scrollTop = pre.scrollHeight;
  }
}
// Where a pane was scrolled to, so a redraw doesn't send you back to the top
function reasoningPos(el) {
  const pre = el.querySelector('.reasoning[open] > pre');
  if (!pre) return null;
  const bottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  return { bottom, top: pre.scrollTop, hold: bottom ? '0' : '1' };
}
// Reopening a thinking pane mid-reply jumps to the latest thought
$('log').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.classList?.contains('reasoning') || !d.open || !d.closest('.msg.streaming')) return;
  followThinking(d.closest('.msg'));
}, true);
// Replace a message's content but keep its button row when that hasn't
// changed, so a click on Stop isn't lost to a redraw mid-click
function patch(el, html) {
  const pos = reasoningPos(el);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild;
  // The orb avatar sits before .who. Keep it, and the element itself, so the
  // pop-in and orbit animations don't start over on every redraw.
  const who = el.querySelector(':scope > .who'), freshWho = fresh.querySelector(':scope > .who');
  // keep tool calls and "How this reply was made" open if they were
  const open = [...el.querySelectorAll('details[data-k]')].filter(d => d.open).map(d => d.dataset.k);
  if (!who || !freshWho || el.className.split(' ')[1] !== fresh.className.split(' ')[1]) {
    fresh.classList.remove('enter');
    el.replaceWith(fresh);
    el = fresh;
  } else {
    // only classes that carry state change; `enter` stays as it was
    for (const c of ['streaming', 'latest']) el.classList.toggle(c, fresh.classList.contains(c));
    if (who.innerHTML !== freshWho.innerHTML) who.innerHTML = freshWho.innerHTML;
    while (el.lastChild !== who) el.lastChild.remove();
    freshWho.remove();
    fresh.querySelector(':scope > .orb-av')?.remove();
    el.append(...fresh.childNodes);
  }
  for (const k of open) { const d = el.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; }
  const pre = el.querySelector('.reasoning[open] > pre');
  if (pos && pre) {
    pre.scrollTop = pos.bottom ? pre.scrollHeight : pos.top;
    // remember a pane the person scrolled up in, so streaming text leaves it alone
    if (pos.hold === '1') pre.dataset.hold = '1'; else delete pre.dataset.hold;
  }
}
// keep elapsed times ticking while a reply is pending
setInterval(() => {
  for (const { reply } of running.values()) if (chat.messages.includes(reply)) redraw(reply);
  if (running.size) drawLiveStatus();
  // the header's counts move while a reply writes, not just when it ends
  if (running.has(chat?.id)) drawStats(false);
}, 250);

$('log').addEventListener('change', (e) => {
  if (e.target.id !== 'quickRoute') return;
  const v = e.target.value;
  applyQuick(chat, v);
  if (!chat.project) { try { localStorage.setItem(NEW_ROUTE_KEY, v); } catch {} }
  saveChat(chat, { touch: false });
  $('quickNote').textContent = quickNote(chat);
  drawRoute(); drawTools(); drawHint(); drawStats(); drawEffort();
});

$('log').addEventListener('click', async (e) => {
  const appr = e.target.closest('[data-approve]');
  if (appr) {
    pendingApprovals.get(appr.dataset.call)?.(appr.dataset.approve === 'allow');
    appr.closest('.approve')?.remove();
    return;
  }
  const sug = e.target.closest('[data-suggest]');
  if (sug) { $('input').value = sug.dataset.suggest; autoGrow(); $('input').focus(); return; }
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
    case 'stop': running.get(chat.id)?.controller.abort(); break;
    case 'resend': resendFrom(chat, m); break;
    case 'edit':
      if (running.has(chat.id)) return toast('Stop the current reply first.');
      if (i < chat.messages.length - 1 && !await ui.confirm('Edit this message? The replies after it will be removed.')) return;
      // editing a command's message puts the command back in the box
      $('input').value = m.turn?.command ? `/${m.turn.command}${m.content ? ` ${m.content}` : ' '}` : m.content;
      await hydrateAttachments(chat, m);
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
// The chat's own repo, else its project's
// A folder on someone's own computer means nothing to a hosted server, which says so with localRepos: false
const hostedNoFolders = () => toolInfo?.localRepos === false;
const repoOf = (c) => (hostedNoFolders() ? null : c?.repo || projectOf(c)?.repo || null);
// The chat's GitHub repo ({ full: "owner/name", branch, private }), attached under Options > Tools
const ghOf = (c) => c?.github || null;
// Skills on for this chat: its own and its project's
function skillsOf(c) {
  const ids = new Set([...(c?.skills || []), ...(projectOf(c)?.skills || [])]);
  return skills.filter(k => ids.has(k.id));
}
// Skills the model may load itself with use_skill
const loadableSkills = (c) => ($('skillTool').checked ? skills.filter(k => !skillsOf(c).includes(k)) : []);

function contextText(c) {
  const parts = [];
  const p = projectOf(c);
  if (p?.instructions?.trim()) parts.push(`Instructions for the project "${p.name}":\n\n${p.instructions.trim()}`);
  if (c.system?.trim()) parts.push(c.system.trim());
  if (c.notes?.trim()) parts.push(`Context notes from the user:\n\n${c.notes.trim()}`);
  for (const k of skillsOf(c)) parts.push(`Skill "${k.name}" is on. Follow it:\n\n${k.body.trim()}`);
  const more = loadableSkills(c);
  if (more.length) {
    parts.push('More skills are available. When a request matches one, call the use_skill tool with its name to read its instructions, then follow them:\n'
      + more.map(k => `- ${k.name}: ${k.description || k.body.slice(0, 120)}`).join('\n'));
  }
  const repo = repoOf(c);
  if (repo) {
    const shell = $('shellInRepo').checked && (toolInfo?.shellDefinitions || []).length;
    parts.push(`This chat is linked to the git repository "${repo.name}" at ${repo.path}${repo.branch ? ` (branch ${repo.branch})` : ''}. Its tools use this chat's own persistent Git worktree, so edits and commands do not affect the original working copy or other chats. `
      + 'Use the repo_ tools to list, read and search its files and to look at its git history before answering questions about it. Paths are relative to the repository root.'
      + (shell ? ' The run_command tool runs a shell command in this chat\'s worktree: every command goes past the command guard, and one it finds risky waits for the user to allow it. Prefer the repo_ tools for reading, and run_command for tests and build steps.' : ''));
  }
  const gh = ghOf(c);
  if (gh) {
    parts.push(`This chat is linked to the GitHub repository ${gh.full}${gh.branch ? ` (default branch ${gh.branch})` : ''}${gh.private ? ', which is private' : ''}. `
      + 'Use the github_ tools to list, read and search its files, look at its commits, branches, issues, pull requests and GitHub Actions runs and logs before answering questions about it. Paths are relative to the repository root. '
      + 'github_create_issue, github_comment, github_create_pull_request, github_run_workflow, github_rerun and github_cancel_run change GitHub: the user is asked to approve each one first, so say what you intend to post and why. You cannot push code or edit files in this repository.');
  }
  return parts.join('\n\n');
}

function userContent(m) {
  const files = (m.attachments || []).filter(a => a.kind === 'text');
  const images = (m.attachments || []).filter(a => a.kind === 'image');
  const text = [m.turn?.command ? commandPrompt(m) : m.content, ...files.map(f => `<file name="${f.name}">\n${f.text}\n</file>`)].filter(Boolean).join('\n\n');
  if (!images.length) return text;
  return [{ type: 'text', text: text || '(see image)' }, ...images.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }))];
}

function apiMessages(c, upTo) {
  const sys = contextText(c);
  return [
    ...(sys ? [{ role: 'system', content: sys }] : []),
    ...c.messages.slice(0, upTo)
      .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.streaming)
      .flatMap(m => (m.role === 'user' ? [{ role: 'user', content: userContent(m) }] : assistantMessages(m, true))),
  ];
}

// An assistant reply as API messages: each round of tool calls with its
// results, then the final text (left out while the reply is still running)
function assistantMessages(m, final) {
  const out = [];
  let from = 0;
  for (const r of m.rounds || []) {
    out.push({
      role: 'assistant',
      content: m.content.slice(from, r.end).trim() || null,
      tool_calls: r.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of r.calls) out.push({ role: 'tool', tool_call_id: c.id, content: c.result ?? 'Stopped before this tool ran.' });
    from = r.end;
  }
  if (final) out.push({ role: 'assistant', content: m.content.slice(from).trim() });
  return out;
}

function busy(on) {
  $('send').textContent = on ? 'Stop' : 'Send';
  $('send').type = on ? 'button' : 'submit';
  $('send').classList.toggle('primary', !on);
}

async function send(text, attachments, turn) {
  const c = chat;
  const r = $('send').getBoundingClientRect();
  window.Bright?.pulse(r.left + r.width / 2, r.top + r.height / 2, 1);
  if (text || attachments.length) c.messages.push({ id: uid(), role: 'user', content: text, attachments: attachments.length ? attachments : undefined, time: Date.now(), ...(turn ? { turn } : {}) });
  await runReply(c, turn);
}

// What a / command did to its turn, for the reply's footer
function turnNote(turn) {
  if (!turn) return '';
  return [turn.model && `${turn.profile ? 'strategy' : 'model'} ${turn.model}`, turn.effort && `effort ${turn.effort}`, turn.tools === false && 'no tools'].filter(Boolean).join(' · ');
}

function regenerate() {
  const c = chat;
  if (running.has(c.id)) return;
  while (c.messages.length && c.messages[c.messages.length - 1].role !== 'user') c.messages.pop();
  if (!c.messages.length) return;
  // a command's answer is regenerated with the same command's model
  const last = c.messages[c.messages.length - 1];
  const command = last.turn?.command && commands.find(x => x.name === last.turn.command);
  runReply(c, command ? commandTurn(command) : null);
}

// Send a user message again: stop any reply in progress, drop what came after it
async function resendFrom(c, m) {
  const r = running.get(c.id);
  if (r) { r.controller.abort(); await r.finished; }
  const i = c.messages.indexOf(m);
  if (i < 0) return;
  if (i < c.messages.length - 1 && c.messages.slice(i + 1).some(x => x.role === 'user')
    && !await ui.confirm('Send this message again? The messages after it will be removed.')) return;
  c.messages.splice(i + 1);
  saveChat(c);
  if (chat === c) drawLog();
  // a command's message goes again with the same command's model
  runReply(c, m.turn?.command ? commandTurn(commands.find(x => x.name === m.turn.command) || { name: m.turn.command }) : null);
}

// Free models often stall or refuse once their daily or per-minute quota is used
const QUOTA_HINT = 'Free models often stall or refuse once their daily or per-minute quota is used up. Retry, wait a while, or pin another model under Options.';
const looksLikeQuota = (text) => /\b429\b|rate.?limit|quota|too many requests|exhausted|exceeded|capacity/i.test(text);
const seconds = (id) => Math.max(0, Number($(id).value) || 0);

async function runReply(c, turn) {
  if (c.sharedFrom && c.sharedRole !== 'edit') return toast(`${c.sharedFrom} shared this chat for viewing only.`);
  await hydrateAttachments(c);
  const reply = { id: uid(), role: 'assistant', content: '', streaming: true, time: Date.now(), trace: { start: Date.now(), chunks: 0 }, ...(turn ? { turn } : {}) };
  c.messages.push(reply);
  saveChat(c);
  if (chat === c) { drawLog(); $('title').placeholder = chatTitle(c); }

  const stream = $('stream').checked;
  // a command's turn carries no tools: a model named there may not call them
  let tools = turn?.tools === false ? [] : activeTools(c);
  // The tool list comes from the harness at page load. A page that failed to get
  // it (or got an empty one) sends a prompt saying "use the repo_ tools" with no
  // tools at all, and the model then promises to read the file and stops with
  // nothing it can call. Load the list again before sending.
  if (!tools.length && turn?.tools !== false) {
    await loadTools();
    tools = activeTools(c);
  }
  reply.toolsMissing = turn?.tools !== false && !tools.length && !!repoOf(c);
  // 0 (or empty, or junk) means no limit: the round loop runs until the model
  // stops asking for tools. The stall and no-reply timeouts still bound it.
  const rawRounds = parseInt($('maxToolRounds').value, 10);
  const maxRounds = Number.isFinite(rawRounds) && rawRounds > 0 ? rawRounds : 0;
  const history = apiMessages(c, c.messages.length - 1);
  const headers = { 'content-type': 'application/json' };
  Object.assign(headers, routeHeaders(c), turnHeaders(turn));

  const controller = new AbortController();
  let finish;
  running.set(c.id, { controller, reply, finished: new Promise(r => { finish = r; }) });
  if (chat === c) busy(true);
  drawList();
  speech.beginReply(reply);

  let tr = reply.trace;
  // Give up on a reply that never starts or stops arriving, instead of
  // waiting forever on a stuck model
  const first = seconds('timeoutFirst'), stall = seconds('timeoutStall');
  tr.lastData = Date.now();
  const watchdog = setInterval(() => {
    if (tr.toolsRunning) return; // a tool call is not the model stalling
    const now = Date.now();
    if (!tr.gotData) {
      if (first && now - tr.start > first * 1000) giveUp(`No reply after ${first} s`);
    } else if (stall && now - tr.lastData > stall * 1000) {
      giveUp(`The reply stopped arriving for ${stall} s`);
    }
  }, 1000);
  const giveUp = (why) => { reply.timedOut = why; controller.abort(); };
  const clientIds = [];
  // What every request of this reply reported, added up (ui/tokens.js reads a
  // provider's usage whatever shape it comes in). A request that reported nothing
  // is filled in from the prompt it sent and the text it wrote, at about 4
  // characters a token, and the total is then marked inexact.
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, exact: true };
  const addUsage = (k, headerCost, tr) => {
    if (!k) {
      k = {
        input: approxTokens(tr.sentChars || 0),
        output: approxTokens(tr.textChars || 0),
        cacheRead: 0, cacheWrite: 0, cost: null, exact: false,
      };
      if (!k.input && !k.output) return;
    }
    total.input += k.input;
    total.output += k.output;
    total.cacheRead += k.cacheRead;
    total.cacheWrite += k.cacheWrite;
    if (!k.exact) total.exact = false;
    if (typeof k.cost === 'number') total.cost += k.cost;
    else if (headerCost > 0) total.cost += headerCost;
    else total.exactCost = false;
  };
  try {
    let toolRounds = 0;  // rounds that really ran tools, for Max tool rounds
    let moreRoom = 0;    // output cap for a second try after a "length" stop
    for (let round = 0; ; round++) {
      // each round of tool calls is a request of its own, routed and logged like any other
      const before = reply.content.length;
      if (round > 0) {
        reply.trace = tr = { start: Date.now(), chunks: 0, lastData: Date.now(), round };
        reply.joinText = true; // a blank line between the text before and after the tools
      }
      const clientId = round ? `${reply.id}-${round}` : reply.id;
      clientIds.push(clientId);
      waiting.set(clientId, reply);
      const body = { model: 'auto', messages: [...history, ...assistantMessages(reply, false)], stream };
      if (stream) body.stream_options = { include_usage: true };
      if (tools.length) body.tools = tools;
      const maxTokens = parseInt($('maxTokens').value, 10);
      if (moreRoom) { body.max_tokens = moreRoom; moreRoom = 0; }
      else if (maxTokens > 0) body.max_tokens = maxTokens;
      if ($('temperature').value !== '') body.temperature = Number($('temperature').value);

      // with a database, the server also keeps the reply if this page goes away before it ends (utils/chatReplies.js)
      const keep = round === 0 && sync.on ? { 'x-harness-chat-id': c.id, 'x-harness-message-id': reply.id } : {};
      if (keep['x-harness-chat-id']) sync.flushNow(c.id); // so the server has the chat, and your message, before the reply starts
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers: { ...headers, ...keep, 'x-harness-request-id': clientId, 'x-harness-cache': 'auto' }, body: JSON.stringify(body), signal: controller.signal });
      // the same facts the live feed sends, from the headers, in case it's not connected
      tr.routed = tr.routed || { model: res.headers.get('x-harness-model'), reason: res.headers.get('x-harness-route') };
      tr.answered = {
        ...tr.answered,
        status: res.status,
        ms: tr.answered?.ms ?? Date.now() - tr.start,
        servedBy: res.headers.get('x-litellm-model-group') || tr.answered?.servedBy || null,
        fallbacks: parseInt(res.headers.get('x-litellm-attempted-fallbacks'), 10) || tr.answered?.fallbacks || 0,
      };
      tr.headerCost = parseFloat(res.headers.get('x-litellm-response-cost')) || 0;
      // how big the prompt this request sends is, for a provider that reports no counts
      tr.sentChars = JSON.stringify(body).length;
      reply.meta = { model: tr.routed.model, route: routeWhy(tr.routed) };
      redraw(reply);
      if (!res.ok) {
        const errText = await res.text();
        let msg = errText;
        try { const j = JSON.parse(errText); msg = j.error?.message || j.error || errText; } catch {}
        throw new Error(`HTTP ${res.status}: ${String(msg).slice(0, 800)}`);
      }
      let calls = [];
      if (stream && res.body) {
        calls = await readStream(res.body, reply, c);
      } else {
        const j = await res.json();
        const msg = j.choices?.[0]?.message || {};
        appendReasoning(reply, msg.reasoning_content ?? msg.reasoning ?? '');
        appendText(reply, msg.content ?? '');
        calls = (msg.tool_calls || []).map(t => ({ id: t.id, name: t.function?.name || '', arguments: t.function?.arguments || '' }));
        tr.finish = j.choices?.[0]?.finish_reason;
        tr.firstToken = Date.now() - tr.start;
        tr.usage = j.usage || null;
        // the text and tool arguments this request generated, for an estimate
        tr.textChars = Tokens.charsOf(j);
        speech.feed(reply);
      }
      tr.done = Date.now() - tr.start;
      addUsage(Tokens.usage(tr.usage), tr.headerCost, tr);
      noteCache(c, tr);
      // a call whose name never arrived (a provider cut it off mid-stream) cannot be run
      if (calls.some(t => !t.name)) tr.droppedCalls = calls.filter(t => !t.name).length;
      calls = calls.filter(t => t.name);
      // A round that gave back nothing at all: no text, no tool call. Some models
      // spend the whole answer thinking and stop, or plan a tool call and never
      // send it. Try once more, with more room when the output cap was the cause.
      if (!calls.length && !reply.content.slice(before).trim() && !reply.emptyRetried) {
        reply.emptyRetried = true;
        // keep the second try's thinking apart from the first's in the pane
        if (reply.reasoning) reply.reasoning += '\n\n';
        if (tr.finish === 'length') moreRoom = Math.min(Math.max(maxTokens, 1024) * 2, 32768);
        continue;
      }
      if (calls.length) toolRounds++;
      if (!calls.length) break;

      // run the tools, then send their results back for the next round
      const r = { end: reply.content.length, calls: calls.map(t => ({ ...t, id: t.id || `call_${uid()}` })) };
      (reply.rounds ||= []).push(r);
      redraw(reply);
      tr.toolsRunning = true;
      for (const call of r.calls) {
        await runTool(call, c, controller.signal, () => redraw(reply));
        // what the advisor's own model cost is part of this reply's cost
        if (typeof call.advisorCost === 'number') total.cost += call.advisorCost;
      }
      tr.toolsRunning = false;
      tr.lastData = Date.now();
      saveChat(c, { touch: false });
      if (maxRounds && toolRounds >= maxRounds) {
        reply.content += `${reply.content ? '\n\n' : ''}*(stopped after ${maxRounds} rounds of tool calls; set Max tool rounds to 0 under Options for no limit)*`;
        break;
      }
    }
    // One total for the whole reply, whatever number of requests and rounds it
    // took, kept on the reply itself (tr.usageParts). Left out only when no
    // request of it reported anything and nothing arrived to estimate from.
    if (total.input || total.output) {
      tr.usageParts = {
        input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite,
        exact: total.exact, ...(total.exactCost === false ? {} : { cost: total.cost }),
      };
      tr.headerCost = 0;
    }
    drawStats();
    // Nothing came back even on the second try: say why, rather than leaving
    // "(empty reply)" with no way to tell what went wrong.
    if (!reply.content.trim() && !reply.rounds?.length && !reply.timedOut) reply.content = emptyNote(reply, tr);
  } catch (err) {
    tr.done = Date.now() - tr.start;
    // a stopped or failed reply still used what it used, so the counts are kept
    if (total.input || total.output) {
      tr.usageParts = {
        input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite,
        exact: total.exact, ...(total.exactCost === false ? {} : { cost: total.cost }),
      };
      tr.headerCost = 0;
    }
    for (const r of reply.rounds || []) for (const call of r.calls) if (call.result == null) { call.result = 'Stopped before this tool finished.'; call.isError = true; }
    const message = err.name === 'AbortError' && reply.timedOut ? `${reply.timedOut}, so the page stopped waiting.` : err.message;
    if (err.name === 'AbortError' && !reply.timedOut) {
      reply.content += reply.content ? '\n\n*(stopped)*' : '*(stopped)*';
    } else if (reply.content || reply.rounds?.length) {
      reply.content += `${reply.content ? '\n\n' : ''}*(cut off: ${message})*`;
    } else {
      // keep the trace on the error so it says how far the request got
      tr.error = message.startsWith('HTTP') ? null : message;
      const hint = reply.timedOut || looksLikeQuota(message) ? QUOTA_HINT : '';
      c.messages.splice(c.messages.indexOf(reply), 1, { id: reply.id, role: 'error', content: message, hint, trace: tr, time: Date.now() });
    }
  } finally {
    clearInterval(watchdog);
    reply.streaming = false;
    delete reply.joinText;
    delete reply.reasoningRound;
    delete reply.reasoningCut;
    delete reply.emptyRetried;
    delete reply.toolsMissing;
    delete tr.toolsRunning;
    if (c.messages.includes(reply)) reply.cost = computeCost(reply);
    running.delete(c.id);
    for (const id of clientIds) waiting.delete(id);
    saveChat(c);
    if (chat === c) { busy(false); drawLog(); } else if (!c.deleted) unseen.add(c.id);
    drawList();
    if (reply.content && !reply.timedOut) nameChat(c);
    speech.endReply(reply);
    if (reply.content && !reply.timedOut && !controller.signal.aborted && c.messages.includes(reply)) window.Notify?.show('reply', `chat.html#chat=${c.id}`);
    finish();
    // a message typed while this reply was arriving goes next, as if you had just sent it
    if (queues.get(c.id)?.length) setTimeout(() => drainQueue(c.id), 0);
  }
}

// The model's thinking, when the provider streams or returns it. A new round
// of tool calls starts a new paragraph of it. Kept in the chat (browser
// storage), so it is capped: a runaway model can think for a long time.
const REASONING_KEEP = 60000;
function appendReasoning(reply, text) {
  if (!text || reply.reasoningCut) return;
  const round = reply.trace?.round || 0;
  if (reply.reasoning && reply.reasoningRound !== round) reply.reasoning += '\n\n';
  reply.reasoningRound = round;
  reply.reasoning = (reply.reasoning || '') + text;
  if (reply.reasoning.length > REASONING_KEEP) {
    reply.reasoning = `${reply.reasoning.slice(0, REASONING_KEEP)}\n\n… (the rest of the thinking was dropped to keep the chat small)`;
    reply.reasoningCut = true;
  }
}

// Why a reply that gave back nothing at all did: a model that spends its whole
// answer thinking and stops, plans a tool call and never sends it (or sends it
// nameless), or is cut off by the output cap. Shown in place of "(empty reply)".
function emptyNote(reply, tr) {
  const thought = (reply.reasoning || '').length;
  const why = tr.finish === 'length' ? 'the output cap cut it off before it said anything, so raise Max tokens'
    : tr.finish === 'content_filter' ? 'the provider’s content filter stopped it'
    : tr.droppedCalls ? `it asked for a tool, but ${tr.droppedCalls > 1 ? `${tr.droppedCalls} calls` : 'the call'} arrived with no name, so nothing could run`
    : reply.toolsMissing ? 'this chat is linked to a repo, but its tool list could not be loaded, so it had no tool to call: reload the page'
    : `it stopped without answering (${tr.finish ? `finish reason: ${tr.finish}` : 'no finish reason'})`;
  return `*(no answer: ${why}${thought ? ` · it thought for ${thought.toLocaleString()} characters first` : ''}. It was tried twice; Regenerate to try again.)*`;
}

// Text from the model; the first text after a round of tool calls starts a new paragraph
function appendText(reply, text) {
  if (!text) return;
  if (reply.joinText) {
    if (reply.content && !reply.content.endsWith('\n\n')) reply.content += reply.content.endsWith('\n') ? '\n' : '\n\n';
    reply.joinText = false;
  }
  reply.content += text;
}

// A risky shell command waits here until you press Allow or Decline (a Stop also
// ends it). Resolves true only for Allow.
const pendingApprovals = new Map(); // call key -> resolve
let approvalCount = 0;
function askApproval(call, reason, onChange, signal) {
  // the buttons in the chat find this by the call's id
  const key = call.id || (call.id = `call_${++approvalCount}`);
  call.approval = { state: 'ask', reason: reason || '' };
  onChange();
  window.Notify?.show('approval', `chat.html#chat=${chat?.id || ''}`);
  return new Promise((resolve) => {
    const settle = (allow) => {
      pendingApprovals.delete(key);
      signal?.removeEventListener('abort', onAbort);
      call.approval = { state: allow ? 'allowed' : 'declined', reason: reason || '' };
      onChange();
      resolve(allow);
    };
    const onAbort = () => settle(false);
    // Stop (or a timeout) ends the wait too, so the reply can't hang here
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingApprovals.set(key, settle);
  });
}

// Ask the advisor. One request, no tools and no streaming: the answer is text the
// model reads. It goes through the Interceptor with the advisor's model named in
// the headers, so its cost lands in this chat's totals like any other request.
const ADVISOR_CTX = 12000;
const ADVISOR_REPLY = 8000;
// What the advisor is told: answer as a reviewer, briefly. A note the person saved
// with the advisor (the command's message) is part of how it answers.
function ADVISOR_SYSTEM(advisor) {
  const note = String(advisor?.note || '').trim();
  return `You are an advisor to another AI agent that is doing the actual work in a code repository. It asks you about the part it is unsure of. Answer as a careful senior engineer: say what is wrong, missing or risky first, then what you would do instead. Be brief and concrete, name the exact change or the next check to run, and say plainly when it looks fine. You cannot read the repo or run anything: work from what the agent sends you, and say what you would need to know if that is not enough.${note ? `\n\nHow this person wants advice: ${note}` : ''}`;
}
async function askAdvisor(advisor, args, signal, c) {
  const question = String(args?.question || '').trim();
  if (!question) throw new Error('the question was empty');
  const context = String(args?.context || '').trim();
  const cut = context.length > ADVISOR_CTX ? `${context.slice(0, ADVISOR_CTX)}\n… (cut at ${ADVISOR_CTX} characters)` : context;
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-harness-model': advisor.model, ...(advisor.effort ? { 'x-harness-effort': advisor.effort } : {}) },
    body: JSON.stringify({
      model: advisor.model,
      stream: false,
      messages: [
        { role: 'system', content: ADVISOR_SYSTEM(advisor) },
        { role: 'user', content: context ? `${question}\n\nContext the agent sent:\n${cut}` : question },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || body.error || `HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => ({}));
  const said = String(body.choices?.[0]?.message?.content || '').trim();
  const cost = body.usage?.cost ?? body.cost;
  if (!said) return { text: 'The advisor answered with nothing. Work it out yourself, or ask again with the question in one sentence.', isError: true, cost: typeof cost === 'number' ? cost : null };
  return { text: said.length > ADVISOR_REPLY ? `${said.slice(0, ADVISOR_REPLY)}\n… (cut at ${ADVISOR_REPLY} characters)` : said, isError: false, cost: typeof cost === 'number' ? cost : null };
}

// The GitHub tools that change something (mirrors utils/githubApi.js describe())
const GITHUB_WRITES = new Set(['github_create_issue', 'github_comment', 'github_create_pull_request', 'github_run_workflow', 'github_rerun', 'github_cancel_run']);
function githubChange(name, a, repo) {
  const clip = (t, n = 400) => (String(t ?? '').length > n ? `${String(t).slice(0, n)}…` : String(t ?? ''));
  if (name === 'github_create_issue') return `Open an issue in ${repo}: “${clip(a.title, 120)}”${a.body ? `\n\n${clip(a.body)}` : ''}`;
  if (name === 'github_comment') return `Comment on #${a.number} in ${repo}:\n\n${clip(a.body)}`;
  if (name === 'github_run_workflow') return `Run workflow ${a.workflow} in ${repo} on ${a.ref || 'the default branch'}${a.inputs && Object.keys(a.inputs).length ? `\n\nInputs: ${JSON.stringify(a.inputs)}` : ''}`;
  if (name === 'github_rerun') return `Run #${a.run_id} again in ${repo}${a.failed_only ? ' (failed jobs only)' : ''}`;
  if (name === 'github_cancel_run') return `Cancel run #${a.run_id} in ${repo}`;
  return `Open a ${a.draft ? 'draft ' : ''}pull request in ${repo}: “${clip(a.title, 120)}” (${a.head} → ${a.base || 'default branch'})${a.body ? `\n\n${clip(a.body)}` : ''}`;
}

// Run one tool call through the harness (MCP server or repo tool)
async function runTool(call, c, signal, onChange) {
  const started = Date.now();
  let args = {};
  try {
    args = call.arguments?.trim() ? JSON.parse(call.arguments) : {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
  } catch (err) {
    call.result = `Error: the arguments were not a valid JSON object (${err.message}). Call the tool again with valid JSON.`;
    call.isError = true;
    call.ms = 0;
    return onChange();
  }
  onChange();
  if (call.name === 'use_skill') {
    const k = skills.find(x => x.name === args.name);
    call.result = k ? k.body : `No skill named "${args.name}". Skills: ${skills.map(x => x.name).join(', ')}`;
    call.isError = !k;
    call.ms = Date.now() - started;
    return onChange();
  }
  // The advisor is called from the page: one plain request to its own model
  if (call.name === 'ask_advisor') {
    const a = advisorOf(c);
    if (!a) {
      call.result = 'Error: no advisor is set for this chat. The person can set one with /advisor MODEL.';
      call.isError = true;
      call.ms = Date.now() - started;
      return onChange();
    }
    try {
      const r = await askAdvisor(a, args, signal, c);
      call.result = r.text;
      call.isError = r.isError;
      call.ms = Date.now() - started;
      if (r.cost != null) call.advisorCost = r.cost;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      call.result = `Error: the advisor could not answer (${err.message})`;
      call.isError = true;
      call.ms = Date.now() - started;
    }
    return onChange();
  }
  let confirmed = false;
  call.approval = null;
  try {
    if (GITHUB_WRITES.has(call.name)) {
      // These change GitHub: the person sees exactly what would be posted and allows or declines it
      const allow = await askApproval(call, githubChange(call.name, args, ghOf(c)?.full), onChange, signal);
      if (!allow) {
        call.result = 'Error: the user declined this GitHub change. Do not try it again; ask what they want instead.';
        call.isError = true;
        call.ms = Date.now() - started;
        onChange();
        return;
      }
      confirmed = true;
    }
    const mcpAsk = (toolInfo?.servers || []).flatMap((s) => s.tools || []).find((t) => t.name === call.name && t.needsApproval);
    if (mcpAsk) {
      // An MCP server set to "ask first" (Tools page): show the input, wait for Allow or Decline
      const allow = await askApproval(call, `${mcpAsk.title || call.name} may change something. Allow it with the input shown below?`, onChange, signal);
      if (!allow) {
        call.result = 'Error: the user declined this tool call. Do not try it again; ask what they want instead.';
        call.isError = true;
        call.ms = Date.now() - started;
        onChange();
        return;
      }
      confirmed = true;
    }
    if (call.name === 'run_command') {
      // Ask the command guard first: a risky command waits here for Allow or Decline
      const check = await fetch('api/tools/shell/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: String(args.command || ''), chatId: c.id, repo: repoOf(c)?.path }),
        signal,
      });
      const v = await check.json().catch(() => ({}));
      if (!check.ok) throw new Error(v.error || `HTTP ${check.status}`);
      if (v.decision === 'deny') {
        call.result = `Error: the harness refused this command (${v.reason || 'blocked by a guard rule'}). Do not run it; find another way or ask the user.`;
        call.isError = true;
        call.ms = Date.now() - started;
        onChange();
        return;
      }
      if (v.decision === 'ask') {
        const allow = await askApproval(call, v.reason, onChange, signal);
        if (!allow) {
          call.result = `Error: the user declined to run this command (${v.reason || 'the guard asked'}). Do not run it again; ask what they want instead.`;
          call.isError = true;
          call.ms = Date.now() - started;
          onChange();
          return;
        }
        confirmed = true;
      }
    }
    const res = await fetch('api/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: call.name, arguments: args, repo: repoOf(c)?.path, githubRepo: ghOf(c)?.full, chatId: c.id, confirmed }),
      signal,
    });
    const j = await res.json().catch(() => ({ text: `Error: HTTP ${res.status}`, isError: true }));
    call.result = j.text ?? (j.error ? `Error: ${j.error}` : '');
    call.isError = !!j.isError || !res.ok;
    call.ms = j.ms ?? Date.now() - started;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    call.result = `Error: could not reach the harness to run this tool (${err.message})`;
    call.isError = true;
    call.ms = Date.now() - started;
  }
  onChange();
}

// OpenAI server-sent events: lines of "data: {json}", ending with "data: [DONE]".
// Returns the tool calls the model asked for, if any.
async function readStream(stream, reply, c) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const tr = reply.trace;
  const calls = [];
  const byIndex = new Map(); // stream index -> call (some providers reuse index 0 for every call)
  let buffer = '', lastSave = Date.now();
  // Streams report usage in pieces and counts only grow, so the largest of each
  // is kept (ui/tokens.js); counting the pieces too gives an estimate for a
  // provider that sends no usage at all
  tr.textChars = tr.textChars || 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    tr.lastData = Date.now(); tr.gotData = true;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim();
      if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (j.usage) tr.usage = Tokens.merge(Tokens.usage(tr.usage), Tokens.usage(j.usage));
      tr.textChars += Tokens.charsOf(j);
      const choice = j.choices?.[0];
      // why it stopped: "length" means the output cap cut the answer off
      if (choice?.finish_reason) tr.finish = choice.finish_reason;
      const d = choice?.delta || {};
      // Providers name the model's thinking differently: OpenRouter and most
      // OpenAI-compatible servers say reasoning, others reasoning_content
      const thought = d.reasoning_content ?? d.reasoning ?? '';
      if (thought) { appendReasoning(reply, thought); redraw(reply); }
      const delta = d.content ?? '';
      if (delta) {
        if (tr.firstToken == null) tr.firstToken = Date.now() - tr.start;
        tr.chunks++;
        appendText(reply, delta);
      }
      // tool calls arrive in pieces, matched by index
      for (const t of d.tool_calls || []) {
        if (tr.firstToken == null) tr.firstToken = Date.now() - tr.start;
        const k = t.index ?? 0;
        let call = byIndex.get(k);
        if (!call || (t.id && call.id && t.id !== call.id)) {
          call = { id: '', name: '', arguments: '' };
          calls.push(call);
          byIndex.set(k, call);
        }
        if (t.id) call.id = t.id;
        const name = t.function?.name;
        if (name && name !== call.name) call.name += name;
        if (t.function?.arguments) call.arguments += t.function.arguments;
      }
    }
    redraw(reply);
    speech.feed(reply);
    if (Date.now() - lastSave > 2000) { saveChat(c, { touch: false }); lastSave = Date.now(); }
  }
  return calls;
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});
function submit() {
  const text = $('input').value.trim();
  if (!text && !pending.length) return;
  // /advisor MODEL sets this chat's advisor and sends nothing
  const asAdvice = advisorCommand(text);
  if (asAdvice) return asAdvice;
  // /subagent and /plan start a run of their own and send nothing to this chat
  const asRun = subagentCommand(text) || agentCommand(text);
  if (asRun) return asRun;
  // a command sends this one message to the command's model
  const slash = slashCommand(text);
  const attachments = pending;
  // A reply is already arriving: keep this message and send it when that one ends,
  // so typing while the model thinks doesn't throw the message away.
  if (running.has(chat.id)) return queue(chat.id, slash ? slash.text : text, attachments, slash ? commandTurn(slash.command) : null);
  dictation.stop();
  $('input').value = '';
  pending = [];
  chat.draft = ''; chat.pendingAttachments = [];
  hideSlash();
  drawChips(); autoGrow();
  send(slash ? slash.text : text, attachments, slash ? commandTurn(slash.command) : null);
}

// "/advisor MODEL" sets a better model this chat's own model may call for a second
// opinion (it gets an ask_advisor tool), or "/advisor off" takes it away. A short
// name finds the newest model the Gateway serves: "opus" -> claude-opus-5.5. The
// setting is saved with the chat, so it lasts until you change it. Returns a
// promise when the message was the advisor command, null when it was anything else.
function advisorCommand(text) {
  const m = /^\/advisor(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const typed = (m[1] || '').trim();
  const c = chat;
  return (async () => {
    if (!typed) {
      const a = advisorOf(c);
      toast(a ? `Advisor: ${a.model}. Type /advisor MODEL to change it, or /advisor off to remove it.` : 'Type /advisor MODEL, e.g. /advisor opus');
      return;
    }
    if (/^(off|none|no)$/i.test(typed)) {
      delete c.advisor;
      saveChat(c, { touch: false });
      drawAdvisor(); drawHint();
      toast('Advisor removed');
      return;
    }
    const pick = resolveModelName(typed);
    if (!pick.model) {
      const near = modelAlias.candidates(typed, gatewayModels || []).slice(0, 6);
      const list = (gatewayModels || []).slice(0, 40).join(', ');
      toast(near.length ? `No model matches "${typed}". Did you mean: ${near.join(', ')}?` : `No model matches "${typed}". Models: ${list}${(gatewayModels || []).length > 40 ? ', …' : ''}`);
      return;
    }
    // the command's message becomes how the advisor is told to answer; its effort
    // carries over too, so /advisor's saved settings still apply
    const cmd = commands.find(x => x.name.toLowerCase() === 'advisor');
    c.advisor = { model: pick.model, typed: pick.from !== pick.model ? pick.from : undefined, note: cmd?.body ? expandCommand(cmd, '').slice(0, 2000) : '', effort: cmd?.effort || null };
    saveChat(c, { touch: false });
    drawAdvisor(); drawHint();
    toast(`Advisor set to ${pick.model}${pick.from !== pick.model ? ` (from "${pick.from}")` : ''}. This chat's model can ask it for a second opinion.`);
  })();
}

// ---------------------------------------------------------------------------
// Subagents: hand one task to an agent of its own, on its own branch, while this
// chat carries on. It is an ordinary run of the Agents page (so it has its own page
// entry, approvals and diff), started from here with the chat's repo, routing and
// effort, and a model of its own if one is named: "subagent [model] task". A
// cheaper model is the point: the chat does the thinking, the subagent does the
// fetching, the searching, the mechanical edit.
// ---------------------------------------------------------------------------

// "/subagent [model] task" or "/subagent plan task". Returns a promise when the
// message was this command, null otherwise.
function subagentCommand(text) {
  const m = /^\/(subagent|plan)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const plan = m[1].toLowerCase() === 'plan';
  const typed = (m[2] || '').trim();
  const c = chat;
  return (async () => {
    const repo = repoOf(c);
    if (!repo) {
      toast(`Link a git repo first (Options → Context): a ${plan ? 'plan' : 'subagent'} works in a copy of it.`);
      return;
    }
    if (!typed) {
      toast(plan
        ? 'Type /plan TASK: an agent reads the repo and writes down what it would change, touching nothing.'
        : 'Type /subagent TASK, or /subagent MODEL TASK to give it a cheaper model, e.g. /subagent haiku find the config loader');
      return;
    }
    // a first word that names a model is the subagent's model; otherwise it is the task
    let model = null, goal = typed;
    if (!plan) {
      const [first, ...rest] = typed.split(/\s+/);
      const pick = rest.length ? resolveModelName(first) : { model: null };
      if (pick.model) { model = pick.model; goal = rest.join(' '); }
    }
    const r = routeOf(c);
    const body = {
      goal, repo: repo.path, plan: plan ? '1' : '0',
      // the chat's own routing, so the subagent follows the same rules
      ...(r.model ? { model: r.model } : r.profile ? { profile: r.profile.id } : {}),
      ...(c.effort && c.effort !== 'auto' ? { effort: c.effort } : {}),
      ...(model ? { model } : {}),
    };
    try {
      const res = await fetch('api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const run = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(run.error || `HTTP ${res.status}`);
      $('input').value = '';
      chat.draft = '';
      autoGrow();
      const what = plan ? 'Plan' : 'Subagent';
      toast(`${what} started: ${run.id}${model ? ` on ${model}` : ''}. It runs on its own branch; open Agents to watch it.`);
      // the chat itself says what it started, so the conversation keeps the thread
      const note = { id: uid(), role: 'assistant', content: `*${what} started: \`${run.id}\`${model ? ` on \`${model}\`` : ''}${plan ? ', changing nothing' : `, on branch \`${run.branch}\``}. Watch it on the [Agents page](agents.html#${run.id}).*`, time: Date.now(), meta: { note: true } };
      c.messages.push(note);
      saveChat(c);
      if (chat === c) drawLog();
    } catch (err) {
      toast(err.message.includes('not running') ? 'The task runner is not running: start it with npm run all.' : `Could not start it: ${err.message}`);
    }
  })();
}

// "/agent [name] task": hand a task to a standing agent (Agents page). In a project
// that is one of its linked agents; outside one, any agent. The task carries the tail of
// this chat, so the agent knows what was being talked about, and the run remembers
// the chat so the Agents page can link back.
const AGENT_CONTEXT_MESSAGES = 6;
function agentCommand(text) {
  const m = /^\/agent(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const typed = (m[1] || '').trim();
  const c = chat;
  return (async () => {
    let agents;
    try {
      const res = await fetch('api/agents');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      agents = body.agents;
    } catch (err) {
      toast(err.message.includes('not running') ? 'The task runner is not running: start it with npm run all.' : `Could not reach the agents: ${err.message}`);
      return;
    }
    const proj = projectOf(c);
    const pool = proj ? agents.filter(a => a.project?.id === proj.id) : agents;
    if (!pool.length) {
      toast(proj ? `No agent is linked to “${proj.name}”. Link one in the project settings, or make one on the Agents page.` : 'No agents yet. Make one on the Agents page.');
      return;
    }
    // the longest agent name the text starts with; one agent in reach is used without being named
    const lower = typed.toLowerCase();
    const named = pool.filter(a => lower === a.name.toLowerCase() || lower.startsWith(`${a.name.toLowerCase()} `))
      .sort((a, b) => b.name.length - a.name.length)[0];
    const agent = named || (pool.length === 1 ? pool[0] : null);
    const task = named ? typed.slice(named.name.length).trim() : typed;
    if (!agent) {
      toast(`Which agent? Type /agent NAME TASK. ${proj ? 'In this project' : 'Agents'}: ${pool.map(a => a.name).join(', ')}.`);
      return;
    }
    if (!task) { toast(`Type /agent ${pool.length > 1 ? `${agent.name} ` : ''}TASK to hand ${agent.name} a task.`); return; }
    const recent = c.messages.filter(x => (x.role === 'user' || x.role === 'assistant') && !x.meta?.note && typeof x.content === 'string' && x.content.trim())
      .slice(-AGENT_CONTEXT_MESSAGES).map(x => `${x.role === 'user' ? 'User' : 'Assistant'}: ${x.content.trim().slice(0, 1500)}`);
    const title = chatTitle(c);
    const goal = recent.length ? `${task}\n\nContext, the latest messages of the chat “${title}” this task came from:\n\n${recent.join('\n\n')}` : task;
    try {
      const res = await fetch(`api/agents/${agent.id}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal, source: { chat: { id: c.id, title } } }) });
      const run = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(run.error || `HTTP ${res.status}`);
      $('input').value = '';
      chat.draft = '';
      autoGrow();
      toast(`${agent.name} has the task: ${run.id}. It builds on its earlier work; open Agents to watch it.`);
      c.messages.push({ id: uid(), role: 'assistant', content: `*Handed to the agent **${agent.name}**: \`${run.id}\`${agent.active ? ' (it is busy, so this waits its turn)' : ''}. Follow it on the [Agents page](agents.html#${run.id}).*`, time: Date.now(), meta: { note: true } });
      saveChat(c);
      if (chat === c) drawLog();
    } catch (err) {
      toast(`Could not hand it over: ${err.message}`);
    }
  })();
}

// Messages typed while a reply is still arriving. They belong to the chat's own id,
// so leaving the chat and coming back doesn't lose them, and each is sent in turn.
const queues = new Map();   // chat id -> [{ text, attachments, turn }]
let draining = false;
function queue(id, text, attachments, turn) {
  if (!queues.has(id)) queues.set(id, []);
  queues.get(id).push({ text, attachments, turn });
  dictation.stop();
  $('input').value = '';
  if (chat?.id === id) { pending = []; chat.draft = ''; chat.pendingAttachments = []; hideSlash(); drawChips(); autoGrow(); }
  drawQueue();
  toast(queues.get(id).length === 1 ? 'Queued: it sends when this reply ends' : `Queued (${queues.get(id).length} waiting)`);
}
// The next message waits for the reply before it: the end of runReply calls this
async function drainQueue(id) {
  if (draining) return;
  const q = queues.get(id);
  if (!q?.length || running.has(id)) return;
  const c = cache.get(id) || loadChat(id);
  if (!c || c.deleted) { queues.delete(id); drawQueue(); return; }
  const next = q.shift();
  if (!q.length) queues.delete(id);
  drawQueue();
  if (chat?.id === id) { drawLog(); }
  draining = true;
  try {
    c.messages.push({ id: uid(), role: 'user', content: next.text, attachments: next.attachments?.length ? next.attachments : undefined, time: Date.now(), ...(next.turn ? { turn: next.turn } : {}) });
    saveChat(c);
    await runReply(c, next.turn);
  } finally {
    draining = false;
  }
  if (queues.has(id)) drainQueue(id);
}
// How many of this chat's messages are waiting, shown under the composer
function drawQueue() {
  const n = queues.get(chat?.id)?.length || 0;
  const el = $('queueNote');
  if (!el) return;
  el.hidden = !n;
  el.innerHTML = n ? `<span>${n} message${n === 1 ? '' : 's'} waiting to send</span><button type="button" id="queueClear" title="Remove the waiting messages">Clear</button>` : '';
}
$('send').addEventListener('click', (e) => {
  const r = running.get(chat.id);
  if (r) { e.preventDefault(); r.controller.abort(); }
});
// Clear removes the messages waiting behind the current reply, without stopping it
$('queueNote').addEventListener('click', (e) => {
  if (!e.target.closest('#queueClear')) return;
  queues.delete(chat.id);
  drawQueue();
  toast('Cleared the waiting messages');
});
$('advisorNote').addEventListener('click', (e) => {
  if (!e.target.closest('#advisorOff')) return;
  delete chat.advisor;
  saveChat(chat, { touch: false });
  drawAdvisor();
  toast('Advisor removed');
});

function autoGrow() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 240) + 'px';
  drawHint();
}

// ---------------------------------------------------------------------------
// Commands. Typing / lists them with the model each one sends to, and under
// them the tools this chat can use. A command is one message sent with a
// model, strategy or effort for that turn only, so /advisor can ask another
// model and the next message goes back to the chat's own routing.
// ---------------------------------------------------------------------------
let slashItems = [];   // command names the menu shows, in order
let slashPick = 0;     // the highlighted one

// The half-typed query after a / (null when the box isn't a command)
function slashQuery(value) {
  const m = /^\/([^\n]*)$/.exec(value);
  return m ? m[1].trim() : null;
}

// A command typed in full: { command, args }. The message keeps the command's
// name and what was typed after it; the instructions it stands for are filled
// in when the request is built, so editing a command changes what it says.
function slashCommand(text) {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const command = commands.find(c => c.name.toLowerCase() === m[1].toLowerCase());
  return command ? { command, args: (m[2] || '').trim() } : null;
}

// The message a command stands for, as it is sent: the instructions replace the
// typed command, with {args} filled in from what followed it
function commandPrompt(m) {
  const c = commands.find(x => x.name.toLowerCase() === String(m.turn?.command || '').toLowerCase());
  return c ? expandCommand(c, m.content || '') : m.content || '';
}

// {args} becomes what was typed after the name; a command with no {args} gets
// it after its message
function expandCommand(command, args) {
  let body = command.body;
  if (body.includes('{args}')) body = body.replace(/\{args\}/g, args || '(what the person is doing now)');
  else if (args) body += `\n\n${args}`;
  return body;
}

// A command's model box takes any model name, or the name of a strategy
function commandModel(command) {
  const w = (command.model || '').trim();
  if (!w) return {};
  const strategy = strategies.profiles.find(x => x.id === w || x.name.toLowerCase() === w.toLowerCase());
  return strategy ? { profile: strategy.id, model: strategy.name } : { model: w };
}

// What a command does to its turn. A model named there may not call tools,
// so the turn carries none and the reply comes back in words.
function commandTurn(command) {
  const pick = commandModel(command);
  return { command: command.name, model: pick.model, profile: pick.profile, effort: command.effort || null, tools: false };
}

// A turn's own route, laid over the chat's for its one request
function turnHeaders(turn) {
  if (!turn) return {};
  const out = {};
  if (turn.profile) out['x-harness-profile'] = turn.profile; else if (turn.model) out['x-harness-model'] = turn.model;
  if (turn.effort && turn.effort !== 'auto') out['x-harness-effort'] = turn.effort;
  return out;
}

function commandItem(c) {
  const where = commandModel(c);
  const bits = [where.profile ? `strategy ${where.model}` : where.model, c.effort && `effort ${c.effort}`].filter(Boolean);
  return `<div class="slash-item" role="option" data-kind="command" data-name="${esc(c.name)}" title="${esc(c.body.slice(0, 300))}">`
    + `<b>/${esc(c.name)} <i>${esc(c.description || '')}</i></b><span class="tag">${esc(bits.join(' · '))}</span>`
    + `<span>${esc(c.body.replace(/\s+/g, ' ').slice(0, 120))}</span></div>`;
}

// Commands the page itself handles (they do something rather than send a message):
// setting the advisor, and starting a subagent or a plan.
const BUILTIN_COMMANDS = [
  { name: 'advisor', what: 'A better model this chat can ask for a second opinion', tag: 'set once', example: '/advisor opus' },
  { name: 'subagent', what: 'Hand one task to an agent on its own branch, on a model of its own', tag: 'one-off run', example: '/subagent haiku find the config loader' },
  { name: 'agent', what: 'Hand a task, with this chat for context, to a standing agent on the Agents page', tag: 'agents page', example: '/agent Docs keeper update the install steps' },
  { name: 'plan', what: 'An agent writes down what it would change, touching nothing', tag: 'no changes', example: '/plan how would you add a --version flag?' },
];
function builtinItem(b) {
  return `<div class="slash-item" role="option" data-kind="builtin" data-name="${esc(b.name)}" title="${esc(b.example)}">`
    + `<b>/${esc(b.name)} <i>${esc(b.what)}</i></b><span class="tag">${esc(b.tag)}</span>`
    + `<span>${esc(b.example)}</span></div>`;
}

function drawSlash() {
  // the first / fills in the examples, so there is something to try
  if (!commands.length) { commands = STARTER_COMMANDS.map(c => ({ id: uid(), ...c })); saveCommands(); }
  const q = slashQuery($('input').value);
  if (q === null || q.includes(' ')) return hideSlash(); // past the name: the message itself
  const needle = q.toLowerCase();
  // the page's own commands come first; they do something instead of sending a message
  const builtins = BUILTIN_COMMANDS.filter(b => !needle || b.name.includes(needle));
  const found = commands.filter(c => (!needle || c.name.toLowerCase().includes(needle)) && !BUILTIN_COMMANDS.some(b => b.name === c.name.toLowerCase()));
  if (!found.length && !builtins.length && needle) return hideSlash();
  const rows = ['<div class="slash-sec">Commands</div>'];
  if (builtins.length) rows.push(builtins.map(builtinItem).join(''));
  if (found.length) rows.push(found.map(commandItem).join(''));
  else if (!builtins.length) rows.push('<div class="slash-none">No commands yet. <button type="button" class="link" id="slashMake">Make one</button></div>');
  // the tools this chat can use, so / shows what the next message may call
  const live = chat ? activeTools(chat) : [];
  if (live.length) {
    rows.push('<div class="slash-sec">Tools this chat can use</div>');
    rows.push(live.map(t => `<div class="slash-item" role="option" aria-disabled="true" data-kind="tool">`
      + `<b>${esc(t.function.name)}</b><span>${esc(String(t.function.description || '').replace(/\s+/g, ' ').slice(0, 140))}</span></div>`).join(''));
  }
  $('slash').innerHTML = rows.join('');
  slashItems = [...$('slash').querySelectorAll('[data-kind="command"], [data-kind="builtin"]')].map(el => el.dataset.name);
  slashPick = Math.min(slashPick, Math.max(0, slashItems.length - 1));
  markSlash();
  $('slash').hidden = false;
}

function markSlash() {
  const els = $('slash').querySelectorAll('[data-kind="command"], [data-kind="builtin"]');
  els.forEach((el, i) => el.classList.toggle('on', i === slashPick));
  els[slashPick]?.scrollIntoView({ block: 'nearest' });
}

function hideSlash() {
  $('slash').hidden = true;
  slashItems = [];
  slashPick = 0;
}

// Put a command in the box, ready for what follows it
function useSlash(name) {
  const args = $('input').value.replace(/^\/[^\s]*\s?/, '');
  const value = `/${name}${args ? ` ${args}` : ' '}`;
  $('input').value = value;
  hideSlash(); autoGrow();
  $('input').focus();
  $('input').setSelectionRange(value.length, value.length);
}

$('slash').addEventListener('mousedown', (e) => {
  // mousedown, so the box keeps its focus
  const item = e.target.closest('[data-kind="command"], [data-kind="builtin"]');
  if (item) { e.preventDefault(); useSlash(item.dataset.name); return; }
  if (e.target.closest('#slashMake')) {
    e.preventDefault();
    const name = (slashQuery($('input').value) || '').trim();
    $('input').value = '';
    hideSlash(); autoGrow();
    newCommand(name);
  }
});

// The menu follows the box: / lists, a name filters, a space means the message
$('input').addEventListener('input', () => {
  if (slashQuery($('input').value) !== null) slashPick = 0;
  autoGrow();
  drawSlash();
});
$('input').addEventListener('keydown', (e) => {
  if (!$('slash').hidden && slashItems.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashPick = (slashPick + 1) % slashItems.length; markSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashPick = (slashPick - 1 + slashItems.length) % slashItems.length; markSlash(); return; }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      // Enter on a command typed in full sends it; either key completes a half-typed one
      if (e.key === 'Enter' && slashCommand($('input').value.trim())) { submit(); return; }
      useSlash(slashItems[slashPick]); return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
document.addEventListener('click', (e) => {
  if (!$('slash').hidden && !e.target.closest('#slash, #composeRow')) hideSlash();
});

function drawContextSize() {
  const chars = ($('system').value + $('notes').value).length;
  $('contextSize').textContent = chars ? `About ${approxTokens(chars).toLocaleString()} tokens of context sent with every message.` : '';
  drawHint();
}

function drawHint() {
  const bits = [];
  const { chars, images } = requestPrompt();
  const total = approxTokens(chars);
  if (total) bits.push(`≈ ${total.toLocaleString()} tokens in this request${images ? ` plus ${images} image${images === 1 ? '' : 's'}` : ''}`);
  const route = chat ? routeOf(chat) : null;
  if (route?.model) bits.push(`straight to ${esc(route.model)}`);
  else if (route?.auto) bits.push('strategy: Auto');
  else if (route?.profile) bits.push(`strategy: ${esc(route.profile.name)}`);
  if (repoOf(chat)) bits.push(`linked to ${esc(repoOf(chat).name)}`);
  if (ghOf(chat)) bits.push(`GitHub ${esc(ghOf(chat).full)}`);
  if (repoOf(chat) && $('shellInRepo').checked && (toolInfo?.shellDefinitions || []).length) bits.push('shell in the repo');
  const on = chat ? skillsOf(chat) : [];
  if (on.length) bits.push(`skill${on.length === 1 ? '' : 's'}: ${on.map(k => esc(k.name)).join(', ')}`);
  // a command in the box sends this message with a model of its own
  const typed = slashCommand($('input').value.trim());
  const note = typed && turnNote(commandTurn(typed.command));
  if (note) bits.push(`/${esc(typed.command.name)}: ${esc(note)}`);
  const advisor = advisorOf(chat);
  if (advisor) bits.push(`advisor ${esc(advisor.model)}`);
  const toolCount = chat ? activeTools(chat).length : 0;
  if (toolCount) bits.push(`${toolCount} tool${toolCount === 1 ? '' : 's'} on`);
  if ($('handsFree').checked) bits.push('hands-free on');
  $('hint').innerHTML = bits.map(b => `<span>${b}</span>`).join('');
  drawStats();
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
// Tools: MCP servers from the harness's mcp-servers.json, and read-only git
// tools for a repo the chat is linked to. Requests carry tools only when one
// is on, since requests with tools go to models that can call them.
// ---------------------------------------------------------------------------

// The advisor: a better model this chat's model can call for a second opinion
// (see utils/advisor.js). Set with "/advisor MODEL"; the setting lives with the
// chat, and each call is one plain request to the advisor's model.
const ADVISOR_TOOL = {
  type: 'function',
  function: {
    name: 'ask_advisor',
    description: 'Ask a stronger model for a second opinion on a hard part of this task: a design choice, a bug you cannot find, a piece of code you are unsure about. Send the question and the code or error text it needs. The advisor answers in words and cannot run tools or change files. Ask once or twice, not for every step.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What you want the advisor to weigh in on, as a clear question' },
        context: { type: 'string', description: 'The code, error message or notes the advisor needs to answer. Paste it rather than naming a file: the advisor cannot read the repo.' },
      },
      required: ['question'],
    },
  },
};
const advisorOf = (c) => c?.advisor?.model ? c.advisor : null;
// Shows in the composer's hint line and the kit, so a chat with an advisor says so
function drawAdvisor() {
  const a = advisorOf(chat);
  const el = $('advisorNote');
  if (el) {
    el.hidden = !a;
    el.innerHTML = a ? `<span>Advisor: <b>${esc(a.model)}</b>${a.typed ? ` (from "${esc(a.typed)}")` : ''} · its model can ask it for a second opinion</span><button type="button" id="advisorOff" title="Remove the advisor">Remove</button>` : '';
  }
  drawHint();
}

// A short name finds the newest model the Gateway serves (utils/modelAlias.js);
// a full name or a Gateway name is used as typed.
function resolveModelName(name) {
  const models = gatewayModels || [];
  if (!models.length) return { model: String(name || '').trim() };
  const found = modelAlias.resolve(name, models);
  return found ? { model: found, from: String(name || '').trim() } : { model: null, from: String(name || '').trim() };
}
function serverTools(c) {
  if (!toolInfo) return [];
  const off = new Set([...(prefs.mcpOff || []), ...routingMcpOff(c)]);
  const list = [];
  for (const s of toolInfo.servers || []) {
    if (s.status === 'connected' && !off.has(s.name)) list.push(...(toolInfo.definitions?.[s.name] || []));
  }
  if (repoOf(c)) list.push(...(toolInfo.repoDefinitions || []));
  if (ghOf(c)) list.push(...(toolInfo.githubDefinitions || []));
  // a shell in the linked repo, unless it is off in the options or the settings
  if (repoOf(c) && $('shellInRepo').checked && (toolInfo.shellDefinitions || []).length) list.push(...toolInfo.shellDefinitions);
  return list;
}
function activeTools(c) {
  const list = serverTools(c);
  // a chat with an advisor set may call it for a second opinion
  if (advisorOf(c)) list.push({ ...ADVISOR_TOOL });
  const more = loadableSkills(c);
  if (more.length) {
    list.push({ type: 'function', function: {
      name: 'use_skill',
      description: 'Read the instructions of one of the user\'s skills. Call it when a request matches a skill listed in the system prompt.',
      parameters: { type: 'object', properties: { name: { type: 'string', enum: more.map(k => k.name) } }, required: ['name'] },
    } });
  }
  return list;
}

async function loadTools() {
  try {
    const res = await fetch('api/tools');
    toolInfo = await res.json();
  } catch {
    toolInfo = null;
  }
  drawTools();
  drawRepo();
  drawGithub();
  drawHint();
}

function drawTools() {
  const off = new Set(prefs.mcpOff || []);
  const blocked = new Set(chat ? routingMcpOff(chat) : []);
  const servers = toolInfo?.servers || [];
  const rows = servers.map(s => {
    const dot = s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'bad' : 'off';
    const detail = blocked.has(s.name) ? 'off in this strategy'
      : s.status === 'connected' ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`
      : s.status === 'disabled' ? 'disabled in the file' : s.status;
    const tip = s.tools.map(t => `${t.title}: ${t.description}`.slice(0, 160)).join('\n');
    return `<li title="${esc(tip)}"><label><input type="checkbox" data-mcp="${esc(s.name)}" ${s.status !== 'connected' || blocked.has(s.name) ? 'disabled' : off.has(s.name) ? '' : 'checked'}>
        <span class="dot ${dot}"></span><span>${esc(s.name)}</span><span class="muted">${esc(detail)}</span></label>
        ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}</li>`;
  });
  if (toolInfo?.error) rows.unshift(`<li class="err">${esc(toolInfo.error)}</li>`);
  $('mcpList').innerHTML = rows.join('') || (toolInfo
    ? `<li class="muted small" title="Same format as Claude Code's .mcp.json; press Reload after editing">None yet. <a href="tools.html">Add one</a> on the Tools page.</li>`
    : '<li class="err">Could not reach the harness.</li>');
}

function onToolToggle(e) {
  const box = e.target.closest('[data-mcp]');
  if (!box) return;
  const off = new Set(prefs.mcpOff || []);
  if (box.checked) off.delete(box.dataset.mcp); else off.add(box.dataset.mcp);
  prefs.mcpOff = [...off];
  store.set(PREF_KEY, prefs);
  drawTools();
  drawHint();
}
$('mcpList').addEventListener('change', onToolToggle);

$('mcpReload').addEventListener('click', async () => {
  $('mcpReload').disabled = true;
  $('mcpList').innerHTML = '<li class="muted small">Connecting…</li>';
  try {
    const res = await fetch('api/tools/reload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) toast((await res.json().catch(() => ({}))).error || `Reload failed: HTTP ${res.status}`);
  } catch (err) {
    toast(`Reload failed: ${err.message}`);
  }
  $('mcpReload').disabled = false;
  loadTools();
});

function drawRepo() {
  const hosted = hostedNoFolders();
  $('repoLink').disabled = hosted && !chat?.repo;
  if (hosted) {
    $('repoInfo').innerHTML = chat?.repo
      ? `This chat's repo is a folder on your own computer (<code>${esc(chat.repo.path)}</code>), which this hosted server cannot read. Unlink it, then attach a GitHub repo below.`
      : 'Folders on your computer cannot be read from this hosted server. Attach a GitHub repo below instead.';
    $('repoPath').value = chat?.repo ? chat.repo.path : '';
    $('repoPath').readOnly = !!chat?.repo;
    $('repoLink').textContent = chat?.repo ? 'Unlink' : 'Link';
    return;
  }
  const r = chat?.repo;
  $('repoPath').value = r ? r.path : $('repoPath').dataset.typed || '';
  $('repoPath').readOnly = !!r;
  $('repoLink').textContent = r ? 'Unlink' : 'Link';
  $('repoInfo').innerHTML = r
    ? `Linked to <b>${esc(r.name)}</b>${r.branch ? ` on <code>${esc(r.branch)}</code>` : ''}${r.head ? ` · last commit ${esc(r.head)}` : ''}. The model uses this chat's private worktree to read its files and history${$('shellInRepo').checked && (toolInfo?.shellDefinitions || []).length ? ', and run guarded commands' : ''}.`
    : projectOf(chat)?.repo
      ? `Using the project's repo <b>${esc(projectOf(chat).repo.name)}</b>. Link another folder here to use that instead.`
      : 'Read-only for the model.';
}

$('repoPath').addEventListener('input', () => { $('repoPath').dataset.typed = $('repoPath').value; });
$('repoPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('repoLink').click(); } });
$('repoLink').addEventListener('click', async () => {
  const c = chat;
  if (c.repo) {
    delete c.repo;
    saveChat(c, { touch: false });
    drawRepo(); drawHint(); drawContextSize();
    return;
  }
  const path = $('repoPath').value.trim();
  if (!path) return toast('Type the path of a folder inside a git repo.');
  $('repoLink').disabled = true;
  try {
    const res = await fetch('api/repo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, chatId: c.id }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    c.repo = { path: j.path, name: j.name, branch: j.branch, head: j.head, remote: j.remote, ...(j.workspacePath ? { workspacePath: j.workspacePath, workspaceBranch: j.workspaceBranch } : {}) };
    $('repoPath').dataset.typed = '';
    saveChat(c, { touch: false });
    if (chat === c) toast(`Linked to ${j.name}.`);
  } catch (err) {
    toast(`Could not link: ${err.message}`);
  } finally {
    $('repoLink').disabled = false;
  }
  if (chat === c) { drawRepo(); drawHint(); drawContextSize(); }
});

// Folder repos found on this computer fill the Git repo fields (chat and project). Typing a path still works.
async function loadLocalRepos() {
  try {
    const j = await (await fetch('api/local-repos')).json();
    $('localRepos').innerHTML = (j.repos || []).map(r => `<option value="${esc(r.path)}">${esc(r.name)}</option>`).join('');
  } catch {}
}
loadLocalRepos();

// GitHub: connect once (Connect GitHub), then attach a repo of yours to this chat. The model reads it
// through GitHub's API, so it works on a hosted server too.
let ghStatus = null;
let ghRepos = null;   // [{ full, private, description, branch }] once loaded
async function loadGithub() {
  try { ghStatus = await (await fetch('api/github/status')).json(); } catch { ghStatus = null; }
  ghRepos = null;
  drawGithub();
  if (ghStatus?.connected) {
    try {
      ghRepos = (await (await fetch('api/github/repos')).json()).repos || [];
      $('ghRepos').innerHTML = ghRepos.map(r => `<option value="${esc(r.full)}">${esc(r.private ? 'private' : 'public')}${r.description ? ` · ${esc(r.description.slice(0, 80))}` : ''}</option>`).join('');
    } catch {}
    drawGithub();
  }
}
function drawGithub() {
  const st = ghStatus;
  const box = $('ghBox');
  const g = ghOf(chat);
  box.hidden = !st || !(st.connected || st.canConnect || g);
  if (box.hidden) return;
  $('ghRepo').value = g ? g.full : $('ghRepo').dataset.typed || '';
  $('ghRepo').readOnly = !!g;
  $('ghAttach').textContent = g ? 'Detach' : 'Attach';
  $('ghRepo').hidden = $('ghAttach').hidden = !st.connected;
  $('ghBox').querySelector('label').hidden = !st.connected;
  const connect = st.canConnect ? `<a href="api/me/github/connect?back=chat.html">${st.connected ? 'Reconnect GitHub' : 'Connect GitHub'}</a>` : '';
  const install = st.connected && st.app && st.installUrl ? ` · <a href="${esc(st.installUrl)}" target="_blank" rel="noopener">Choose which repos it can reach</a>` : '';
  $('ghInfo').innerHTML = !st.connected
    ? `${connect || esc(st.note || 'GitHub is not connected.')} to let the model read your repos.`
    : g
      ? `Attached <b>${esc(g.full)}</b>${g.branch ? ` (<code>${esc(g.branch)}</code>)` : ''} as <b>${esc(st.login || '')}</b>. The model reads files, commits, issues and pull requests; opening an issue, comment or pull request waits for your Allow. ${connect}${install}`
      : `Connected as <b>${esc(st.login || '')}</b>${st.via === 'env' ? ' (GITHUB_TOKEN)' : ''}. Pick one of your repos or type owner/name. ${connect}${install}`;
}
$('ghRepo').addEventListener('input', () => { $('ghRepo').dataset.typed = $('ghRepo').value; });
$('ghRepo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ghAttach').click(); } });
$('ghAttach').addEventListener('click', async () => {
  const c = chat;
  if (c.github) {
    delete c.github;
    saveChat(c, { touch: false });
    drawGithub(); drawHint(); drawContextSize();
    return;
  }
  const repo = $('ghRepo').value.trim();
  if (!repo) return toast('Pick a repo or type owner/name.');
  $('ghAttach').disabled = true;
  try {
    const res = await fetch('api/github/repo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    c.github = { full: j.full, branch: j.branch, private: j.private };
    $('ghRepo').dataset.typed = '';
    saveChat(c, { touch: false });
    if (chat === c) toast(`Attached ${j.full}.`);
  } catch (err) {
    toast(`Could not attach: ${err.message}`);
  } finally {
    $('ghAttach').disabled = false;
  }
  if (chat === c) { drawGithub(); drawHint(); drawContextSize(); }
});
// Back from GitHub (api/me/github/callback): ?github=connected, or the reason it did not work
{
  const back = new URLSearchParams(location.search).get('github');
  if (back) {
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => toast(back === 'connected' ? 'GitHub connected. Attach a repo under Options → Tools.' : `GitHub: ${back === 'unavailable' ? 'not available on this server or account' : back}`), 300);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function chatMarkdown(c) {
  const out = [`# ${chatTitle(c)}`, '', `_Exported from Bright Chat on ${new Date().toLocaleString()}_`, ''];
  const p = projectOf(c);
  if (p) out.push(`_Project: ${p.name}_`, '');
  if (p?.instructions?.trim()) out.push('## Project instructions', '', p.instructions.trim(), '');
  if (skillsOf(c).length) out.push(`_Skills: ${skillsOf(c).map(k => k.name).join(', ')}_`, '');
  if (c.system?.trim()) out.push('## System prompt', '', c.system.trim(), '');
  if (c.notes?.trim()) out.push('## Context notes', '', c.notes.trim(), '');
  if (c.repo) out.push(`_Linked to the git repo ${c.repo.name} (${c.repo.path})_`, '');
  if (c.github) out.push(`_Linked to the GitHub repo ${c.github.full}_`, '');
  for (const m of c.messages) {
    if (m.role === 'user') {
      out.push('## You', '');
      if (m.turn?.command) out.push(`**/${m.turn.command}**${turnNote(m.turn) ? ` _(${turnNote(m.turn)})_` : ''}`, '');
      if (m.content) out.push(m.content, '');
      for (const a of m.attachments || []) {
        if (a.kind === 'image') out.push(`_Attached image: ${a.name}_`, '');
        else out.push(`<details><summary>Attached file: ${a.name}</summary>`, '', '```', a.text, '```', '', '</details>', '');
      }
    } else if (m.role === 'assistant') {
      const tr = m.trace;
      const model = tr?.answered?.servedBy || tr?.routed?.model || m.meta?.model;
      const why = routeWhy(tr?.routed) || m.meta?.route;
      out.push(`## Assistant${model ? ` (${model}${why ? `, ${why}` : ''})` : ''}`, '');
      let from = 0;
      for (const r of m.rounds || []) {
        const text = m.content.slice(from, r.end).trim();
        if (text) out.push(text, '');
        for (const t of r.calls) {
          out.push(`<details><summary>Tool call: ${t.name}${t.isError ? ' (failed)' : ''}</summary>`, '', '```json', prettyArgs(t.arguments), '```', '', '```', t.result ?? '', '```', '', '</details>', '');
        }
        from = r.end;
      }
      out.push(m.content.slice(from).trim(), '');
    } else if (m.role === 'error') {
      out.push('## Error', '', '```', m.content, '```', '');
    }
  }
  return out.join('\n');
}
const fileName = (c) => `${chatTitle(c).replace(/[\\/:*?"<>|\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat'}.md`;

$('exportChat').addEventListener('click', async () => {
  if (!chat.messages.length) return toast('Nothing to export yet.');
  await hydrateAttachments(chat);
  download(fileName(chat), chatMarkdown(chat));
});
$('copyChat').addEventListener('click', async () => {
  if (!chat.messages.length) return toast('Nothing to copy yet.');
  await hydrateAttachments(chat);
  await copyText(chatMarkdown(chat));
  toast('Chat copied as Markdown.');
});
$('exportAll').addEventListener('click', async () => {
  const chats = index.map(e => loadChat(e.id)).filter(Boolean);
  for (const c of chats) await hydrateAttachments(c);
  if (!chats.length) return toast('No saved chats yet.');
  download(`bright-chats-${new Date().toISOString().slice(0, 10)}.md`, chats.map(chatMarkdown).join('\n\n---\n\n'));
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
      body: JSON.stringify({ text, model: $('serverModel').value || undefined, voice: $('serverVoice').value || undefined, speed: Number($('rate').value) || 1 }),
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

  load(item) {
    if (item.audio) return;
    item.audio = this.fetchAudio(item.text);
    item.audio.catch(() => {});
  },

  // Fetch only the piece playing and the one after it: enough for no gap
  // between pieces, and stopping wastes at most one piece of speech tokens
  pump() {
    if (!this.playing && this.items.length) this.start(this.items.shift());
    if (this.items[0]) this.load(this.items[0]);
  },

  start(item) {
    this.playing = item;
    this.load(item);
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

  sent: 0,            // pieces queued for the current read
  gen: 0,             // bumped by stop(), so pieces cut off then don't count
  // A short first piece so speech starts quickly, then longer ones (fewer
  // requests, smoother audio). The server's speech models take the longest.
  pieceMax() {
    const sizes = this.engine === serverTTS ? [120, 240, 400] : [120, 220];
    return sizes[Math.min(this.sent, sizes.length - 1)];
  },

  enqueue(text, id) {
    if (!this.ok || !text.trim()) return;
    const engine = this.engine;
    // sentences, and long sentences at their commas
    const pieces = (text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [text])
      .flatMap(p => (p.length > 220 ? p.match(/[^,;:]+[,;:]*\s*/g) || [p] : [p]));
    let chunk = '';
    const flush = () => {
      if (!/[\p{L}\p{N}]/u.test(chunk)) { chunk = ''; return; }
      this.queue++;
      this.sent++;
      const gen = this.gen;
      engine.play(chunk.trim(), () => { if (gen === this.gen && --this.queue <= 0) this.idle(id); });
      chunk = '';
    };
    for (const p of pieces) { if (chunk && (chunk + p).length > this.pieceMax()) flush(); chunk += p; }
    flush();
    this.current = id;
    this.mark(id);
  },

  say(markdown, id) {
    this.stop();
    dictation.pause();
    this.enqueue(speechText(markdown), id);
  },

  stop() {
    const was = this.current;
    this.queue = 0;
    this.sent = 0;
    this.gen++;
    this.current = null;
    // stopping mid-reply stops reading that reply, not just this piece
    if (this.replying) { this.spoken.delete(this.replying.id); this.replying = null; }
    browserTTS.stop();
    serverTTS.stop();
    if (was) this.mark(was);
  },

  idle(id) {
    this.queue = 0;
    if (this.current === id) this.current = null;
    this.mark(id);
    // caught up with a reply that is still arriving: read what has come since
    const r = this.replying;
    if (r?.streaming && this.spoken.has(r.id)) { this.feed(r); if (this.queue) return; }
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
    this.replying = reply;
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
      // while speech is still playing, gather a longer piece: fewer requests
      if (this.queue > 0 && to - from < this.pieceMax()) return;
    }
    if (to <= from) return;
    this.spoken.set(reply.id, to);
    dictation.pause();
    this.enqueue(speechText(text.slice(from, to)), reply.id);
  },

  endReply(reply) {
    if (this.spoken.has(reply.id)) {
      if (!/\*\((stopped|cut off)/.test(reply.content)) this.feed(reply, true);
      this.spoken.delete(reply.id);
    }
    if (this.replying === reply) this.replying = null;
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
  if (!info?.configured) opt.textContent = 'Speech model (needs OPENROUTER_API_KEY or TTS_URL)';
  if (info?.configured) {
    // free models first, then by name
    const models = [...info.models].sort((a, b) => (b.free - a.free) || (a.id === info.model ? -1 : b.id === info.model ? 1 : 0) || a.name.localeCompare(b.name));
    $('serverModel').innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}${m.free && !/free/i.test(m.name) ? ' · free' : ''}</option>`).join('');
    $('serverModel').value = prefs.serverModel && models.some(m => m.id === prefs.serverModel) ? prefs.serverModel : info.model;
    drawServerVoices();
    // the server's model is the default read-aloud until the user picks otherwise
    if (prefs.ttsEngine === undefined) $('ttsEngine').value = 'server';
  }
  drawEngine();
}

function drawServerVoices() {
  const info = serverTTS.info;
  const model = info.models.find(m => m.id === $('serverModel').value);
  const voices = model?.voices || [];
  // most models need a voice; only offer "default" when the model lists none
  const fallback = (model?.id === info.model && info.voice) || voices[0] || '';
  $('serverVoice').innerHTML = (voices.length ? '' : '<option value="">Model default</option>') +
    voices.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (fallback && !voices.includes(fallback)) $('serverVoice').insertAdjacentHTML('beforeend', `<option value="${esc(fallback)}">${esc(fallback)}</option>`);
  $('serverVoice').value = prefs.serverVoice && [...$('serverVoice').options].some(o => o.value === prefs.serverVoice) ? prefs.serverVoice : fallback;
}

function drawEngine() {
  const server = $('ttsEngine').value === 'server' && serverTTS.ok;
  if ($('ttsEngine').value === 'server' && !serverTTS.ok) $('ttsEngine').value = 'browser';
  $('voice').hidden = server;
  $('serverVoice').hidden = !server;
  $('serverModelRow').hidden = !server;
  document.querySelector('[data-engine=browser]').hidden = server;
  const model = server && serverTTS.info.models.find(m => m.id === $('serverModel').value);
  $('voiceNote').textContent = [
    !SR && !serverSTT.ok && 'Dictation needs Chrome or Edge, or a speech model (add OPENROUTER_API_KEY or STT_URL to .env).',
    !window.isSecureContext && 'The microphone works only on http://localhost or https.',
    serverSTT.ok ? 'Dictation goes to the speech model on the harness, not to the browser’s speech service.'
      : SR && 'The browser answers dictation with its own speech service; Brave has none.',
    server ? `Replies are spoken by ${model?.name || $('serverModel').value} via ${serverTTS.info.host}${model?.free ? ' (free)' : ' (paid)'}.`
      : !browserTTS.ok ? 'This browser cannot read aloud.'
      : 'For browser voices, Edge’s ★ Natural voices sound best.',
  ].filter(Boolean).join(' ');
}

$('testVoice').addEventListener('click', () => {
  if (speech.current === 'test') return speech.stop();
  speech.say('Hi! This is how replies will sound when they are read aloud.', 'test');
});

// ---------------------------------------------------------------------------
// Dictation. Two engines: the browser's SpeechRecognition (Chrome and Edge
// have it, and it is free and instant) or the harness's speech model
// (/ui/api/stt), which Brave and other Chromium builds need because they ship
// without a speech service and answer every attempt with "network".
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MR = window.MediaRecorder;
// set when this browser's own recognition fails for want of a speech service
let browserBroken = false;

// Harness STT server: GET /ui/api/stt says whether one is configured
const serverSTT = {
  info: null,
  get ok() { return !!this.info?.configured; },
};

async function loadServerSTT() {
  try {
    serverSTT.info = await (await fetch('api/stt')).json();
  } catch {
    serverSTT.info = null;
  }
  drawEngine();
  dictation.draw();
}

const dictation = {
  rec: null,         // the browser's recogniser
  want: false,       // the user turned the mic on
  paused: false,     // paused while a reply is read aloud
  base: '',          // text in the box before this stretch of speech
  silence: null,
  media: null,       // the recorder, for the server engine
  starting: false,   // waiting on the microphone permission
  stream: null,
  chunks: [],
  ctx: null,
  analyser: null,
  meter: null,
  spoke: false,      // the segment has something in it worth sending
  quietSince: 0,
  discard: false,    // the next stop is a pause or a cancel: drop the audio
  segmentStart: 0,
  listening: false,  // the browser recogniser has the microphone open
  heard: false, quiet: 0, startedAt: 0,

  // Which engine to use now: the browser's own unless it has none, or the
  // user picked the server
  get engine() {
    const choice = $('sttEngine').value;
    if (choice === 'browser') return SR ? 'browser' : 'none';
    if (choice === 'server') return serverSTT.ok ? 'server' : 'none';
    const browser = SR && !browserBroken;
    if (browser) return 'browser';
    return serverSTT.ok ? 'server' : 'none';
  },
  get ok() { return this.engine !== 'none'; },

  start() {
    if (!this.ok) {
      return toast(serverSTT.info === null || serverSTT.info?.configured === false
        ? 'Dictation needs Chrome or Edge, or a speech model (OPENROUTER_API_KEY or STT_URL in .env).'
        : 'Dictation needs a microphone.');
    }
    speech.stop();
    this.want = true; this.paused = false;
    this.begin();
  },

  // Pick up after a pause, a cut segment or a broken browser recogniser
  begin() {
    if (!this.want || this.paused) return;
    if (this.engine === 'server') this.listenServer(); else this.listen();
  },

  // --- the browser's own recognition -------------------------------------
  listen() {
    if (this.rec) return;
    const rec = new SR();
    rec.continuous = DictationText.wantsContinuous(navigator.userAgent);
    rec.interimResults = true;
    rec.lang = $('sttLang').value.trim() || navigator.language || 'en-US';
    const box = $('input');
    this.base = box.value ? box.value.replace(/\s*$/, ' ') : '';
    this.heard = false; this.startedAt = Date.now();
    rec.onstart = () => { this.listening = true; this.draw(); };
    rec.onresult = (e) => {
      // rebuilt from every result each time: Android resends cumulative text
      const all = [];
      for (let k = 0; k < e.results.length; k++) all.push({ transcript: e.results[k][0].transcript, isFinal: e.results[k].isFinal });
      const text = DictationText.sessionText(all);
      if (text.final || text.interim) { this.heard = true; this.quiet = 0; }
      box.value = DictationText.compose(this.base, text);
      autoGrow();
      clearTimeout(this.silence);
      if ($('autoSend').checked && text.final && !text.interim) {
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
      const info = DictationText.describeError(e.error);
      // No speech service in this browser (Brave, some Chromium builds): the
      // harness's speech model does the same job, so carry on with that
      if ((e.error === 'network' || e.error === 'service-not-allowed') && !browserBroken && serverSTT.ok) {
        browserBroken = true;
        this.rec = null; this.listening = false;
        toast('This browser has no speech service. Dictating through the harness instead.');
        this.draw();
        this.begin();
        return;
      }
      console.warn('Dictation error:', e.error, e.message || '');
      if (!info.stop) return;
      this.want = false; this.listening = false;
      this.rec = null;
      toast(info.text);
      this.draw();
    };
    rec.onend = () => {
      this.rec = null; this.listening = false;
      // browsers end recognition after a pause; keep going while the mic is on,
      // but give up when it keeps ending with nothing heard (denied, no mic)
      if (this.want && !this.paused) {
        this.quiet = this.heard ? 0 : (this.quiet || 0) + 1;
        if (this.quiet >= (Date.now() - this.startedAt < 800 ? 4 : 3)) {
          this.want = false; this.quiet = 0;
          toast(this.startedAt && Date.now() - this.startedAt < 800
            ? 'Dictation keeps stopping at once. Check the microphone is allowed for this page and not in use by another app.'
            : 'Dictation heard nothing. Check the right microphone is selected, then click the mic to try again.');
        } else setTimeout(() => this.begin(), 150);
      }
      this.draw();
    };
    try { rec.start(); this.rec = rec; } catch (err) { toast(`Dictation: ${DictationText.errText(err)}`); this.want = false; }
    this.draw();
  },

  // --- the harness's speech model ----------------------------------------
  async listenServer() {
    if (this.media || this.starting) return;
    if (!MR || !navigator.mediaDevices?.getUserMedia) { this.want = false; this.draw(); return toast('This browser cannot record audio.'); }
    this.starting = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      this.starting = false; this.want = false; this.draw();
      return toast(err.name === 'NotAllowedError'
        ? 'The microphone is blocked. Allow it for this page (it needs http://localhost or https).'
        : `Microphone: ${DictationText.errText(err)}`);
    }
    this.starting = false;
    // the mic was turned off or paused while the permission prompt was up
    if (!this.want || this.paused) { for (const t of stream.getTracks()) t.stop(); return; }
    this.stream = stream;
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find((t) => !MR.isTypeSupported || MR.isTypeSupported(t)) || '';
    const rec = new MR(stream, type ? { mimeType: type } : undefined);
    this.media = rec; this.chunks = []; this.spoke = false; this.segmentStart = Date.now();
    rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    rec.onstop = () => this.finishSegment(rec, type);
    try { rec.start(1000); } catch (err) { this.media = null; for (const t of stream.getTracks()) t.stop(); toast(`Dictation: ${DictationText.errText(err)}`); this.want = false; }
    this.meterStart();
    this.draw();
  },

  // Loudness of the microphone, so a pause can end a segment and be sent
  meterStart() {
    this.meterStop();
    this.quietSince = 0;
    let analyser = null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const source = this.ctx.createMediaStreamSource(this.stream);
      analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    } catch { this.meterStop(); }
    // Without a loudness reading (no AudioContext), send every few seconds so
    // dictation still works; there is just no pause detection to end a segment
    if (!analyser) {
      this.meter = setInterval(() => {
        if (!this.media) return;
        this.spoke = true;
        if (Date.now() - this.segmentStart > 15000) this.cut();
      }, 500);
      return;
    }
    this.analyser = analyser;
    const buf = new Float32Array(analyser.fftSize);
    this.meter = setInterval(() => {
      if (!this.analyser || !this.media) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      if (rms > 0.02) { this.spoke = true; this.quietSince = 0; return; }
      if (!this.spoke) return;
      if (!this.quietSince) this.quietSince = Date.now();
      // a pause after speech ends the segment; so does 25 seconds of it
      if (Date.now() - this.quietSince > 1200 || Date.now() - this.segmentStart > 25000) this.cut();
    }, 100);
  },

  meterStop() {
    clearInterval(this.meter);
    this.meter = null;
    this.analyser = null;
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
  },

  // End this stretch of recording; the rest arrives in onstop
  cut() {
    if (!this.media) return;
    if (!this.spoke) { this.segmentStart = Date.now(); return; }
    this.meterStop();
    try { this.media.stop(); } catch {}
  },

  async finishSegment(rec, type) {
    const chunks = this.chunks;
    const spoke = this.spoke;
    const discard = this.discard;
    this.chunks = []; this.spoke = false; this.discard = false;
    this.media = null;
    this.meterStop();
    const stream = this.stream;
    this.stream = null;
    for (const t of stream?.getTracks() || []) t.stop();
    this.draw();
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
    if (spoke && !discard && blob.size) await this.transcribe(blob);
    if (this.want && !this.paused) setTimeout(() => this.begin(), 100);
  },

  async transcribe(blob) {
    let text = '';
    try {
      const audio = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
        reader.onerror = () => reject(reader.error || new Error('could not read the recording'));
        reader.readAsDataURL(blob);
      });
      const res = await fetch('api/stt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio, format: blob.type, language: $('sttLang').value.trim() }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { console.warn('Dictation: speech server answered', res.status, out); throw new Error(out.error ? DictationText.errText(out, res.status) : `The server did not answer (HTTP ${res.status}). If this is the hosted app, the speech model may be down or the app asleep; try again.`); }
      text = String(out.text || '').trim();
    } catch (err) {
      console.warn('Dictation:', err);
      toast(`Dictation: ${DictationText.errText(err)}`);
    }
    if (!text) return;
    const box = $('input');
    box.value = (box.value ? box.value.replace(/\s*$/, ' ') : '') + text;
    autoGrow();
    if ($('autoSend').checked && !running.has(chat.id)) {
      const handsFree = $('handsFree').checked;
      box.value = '';
      submit();
      if (handsFree) { this.want = true; this.paused = true; this.draw(); }
    }
  },

  stop() {
    this.want = false; this.paused = false;
    clearTimeout(this.silence);
    this.rec?.stop();
    this.media?.stop(); // what was said so far is still transcribed
    this.draw();
  },

  // Stop listening while the page talks, so it doesn't hear itself
  pause() {
    if (!this.want) return;
    this.paused = true;
    clearTimeout(this.silence);
    this.rec?.abort();
    if (this.media) { this.discard = true; this.media.stop(); }
    this.draw();
  },

  resume() {
    if (!this.ok || !$('handsFree').checked) return;
    this.want = true; this.paused = false;
    this.begin();
  },

  draw() {
    const engine = this.engine;
    const on = this.want && !this.paused;
    $('mic').classList.toggle('listening', on);
    // say plainly whether the microphone is open
    const open = on && (engine === 'server' ? !!this.media : this.listening);
    $('input').placeholder = on ? (open ? 'Listening… speak now' : 'Starting the microphone…') : 'Message';
    $('mic').disabled = engine === 'none';
    $('mic').title = engine === 'none' ? 'Dictation needs Chrome, Edge, or a speech model'
      : on ? 'Stop dictating (Ctrl+M)'
      : engine === 'server' ? 'Dictate through the harness’s speech model (Ctrl+M)'
      : 'Dictate (Ctrl+M)';
    drawHandsFree();
  },
};
$('mic').addEventListener('click', () => (dictation.want && !dictation.paused ? dictation.stop() : dictation.start()));

// The composer's hands-free button is the Options checkbox plus the mic:
// turning it on starts listening now, turning it off stops listening and reading
function setHandsFree(on) {
  const box = $('handsFree');
  if (box.checked !== on) { box.checked = on; box.dispatchEvent(new Event('change')); }
  if (on) { if (!dictation.want || dictation.paused) dictation.start(); toast('Hands-free on: talk, pause to send, and it reads the reply.'); }
  else { dictation.stop(); speech.stop(); }
  drawHandsFree();
}
function drawHandsFree() {
  const btn = $('handsFreeBtn');
  const on = $('handsFree').checked;
  btn.classList.toggle('on', on);
  btn.classList.toggle('live', on && dictation.want);
  btn.setAttribute('aria-pressed', String(on));
  btn.disabled = !dictation.ok;
  btn.title = !dictation.ok ? 'Hands-free needs Chrome, Edge, or a speech model'
    : on && !dictation.want ? 'Hands-free is on but not listening. Click to start listening'
    : on ? 'Hands-free is on. Click to stop listening and reading'
    : 'Hands-free: talk, it sends when you pause, reads the reply, then listens again';
}
// on but idle (after a reload, or the mic was stopped): a click starts listening
$('handsFreeBtn').addEventListener('click', () => setHandsFree(!$('handsFree').checked || !dictation.want));
drawHandsFree();
loadServerTTS();
loadServerSTT();

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
    if (type === 'route') tr.routed = { model: event.model, profile: event.profile, reason: event.reason, winRate: event.winRate, threshold: event.threshold, routerError: event.routerError, transforms: event.transforms, routeMs: event.routeMs, tier: event.tier, effort: event.effort, auto: event.auto };
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
  if (open && !$('options').hidden) setOptions(false);
  $('activity').hidden = !open;
  $('actScrim').hidden = !open;
  $('toggleActivity').setAttribute('aria-expanded', String(open));
  $('toggleActivity').classList.toggle('on', open);
  if (open) { drawFeed(); loadHealth(); }
}
$('toggleActivity').addEventListener('click', () => setActivity($('activity').hidden));
$('closeActivity').addEventListener('click', () => { setActivity(false); $('toggleActivity').focus(); });
$('actScrim').addEventListener('click', () => setActivity(false));
// The settings drawer: one section at a time, the last one remembered. It slides
// over the chat's right edge; on a phone it covers the page and the dim area closes it.
const OPT_TAB_KEY = 'harness-chat-options-tab';
function setOptionsTab(name) {
  if (!$('options').querySelector(`.opt-tabs [data-tab="${name}"]`)) name = 'model';
  $('options').dataset.tab = name;
  for (const b of $('options').querySelectorAll('.opt-tabs [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  try { localStorage.setItem(OPT_TAB_KEY, name); } catch {}
}
function setOptions(open) {
  $('options').hidden = !open;
  $('optScrim').hidden = !open;
  $('toggleOptions').classList.toggle('on', open);
  $('toggleOptions').setAttribute('aria-expanded', String(open));
  if (open) { if (!$('activity').hidden) setActivity(false); $('options').querySelector('.opt-tabs [aria-selected=true]')?.focus({ preventScroll: true }); }
}
let savedTab = 'model';
try { savedTab = localStorage.getItem(OPT_TAB_KEY) || 'model'; } catch {}
setOptionsTab(savedTab);
$('toggleOptions').addEventListener('click', () => setOptions($('options').hidden));
$('closeOptions').addEventListener('click', () => { setOptions(false); $('toggleOptions').focus(); });
$('optScrim').addEventListener('click', () => setOptions(false));
$('options').querySelector('.opt-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setOptionsTab(b.dataset.tab); });
$('options').querySelector('.opt-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...$('options').querySelectorAll('.opt-tabs [data-tab]')];
  const next = tabs[(tabs.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  e.preventDefault(); next.focus(); setOptionsTab(next.dataset.tab);
});
// before the keyboard handler below, so Esc closes the drawer and doesn't stop a reply
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('activity').hidden) { setActivity(false); $('toggleActivity').focus(); e.stopImmediatePropagation(); return; }
  if (e.key === 'Escape' && !$('options').hidden && $('options').contains(document.activeElement)) { setOptions(false); $('toggleOptions').focus(); e.stopImmediatePropagation(); }
});

// ---------------------------------------------------------------------------
// Chat names: after the first reply, a short request asks for a title
// ---------------------------------------------------------------------------
const naming = new Set();
async function nameChat(c) {
  if (c.title || c.named || naming.has(c.id) || !$('autoName').checked || c.deleted) return;
  const first = c.messages.find(m => m.role === 'user' && m.content);
  const answer = c.messages.find(m => m.role === 'assistant' && m.content);
  if (!first || !answer) return;
  naming.add(c.id);
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-request-id': `name-${c.id}-${uid()}` },
      body: JSON.stringify({
        model: 'auto',
        stream: false,
        max_tokens: 30,
        messages: [
          { role: 'system', content: 'You name chat conversations. Reply with only a short title of 2 to 6 words in the language of the conversation: no quotes, no full stop, no emoji.' },
          { role: 'user', content: `Name this chat.\n\nUser: ${first.content.slice(0, 1200)}\n\nAssistant: ${answer.content.slice(0, 600)}` },
        ],
      }),
    });
    if (!res.ok) return;
    const j = await res.json();
    const raw = String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const name = raw.split('\n').map(l => l.trim()).find(Boolean)?.replace(/^(title|name)\s*:\s*/i, '').replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, '').slice(0, 60);
    if (!name || c.title || c.deleted) return;
    c.title = name;
    c.named = true;
    saveChat(c, { touch: false });
    if (chat === c) { $('title').value = name; $('title').classList.add('renamed'); setTimeout(() => $('title').classList.remove('renamed'), 1200); }
    drawList();
  } catch {
    // keep the first message as the name
  } finally {
    naming.delete(c.id);
  }
}

// ---------------------------------------------------------------------------
// Projects: chats grouped with shared instructions, skills and a repo
// ---------------------------------------------------------------------------
function drawProjectBits() {
  const p = projectOf(chat);
  const badge = $('projectBadge');
  badge.hidden = !p;
  if (p) { badge.innerHTML = `<i class="pdot" style="background:${p.color}"></i>${esc(p.name)}`; badge.title = 'Project settings'; }
  $('chatProject').innerHTML = '<option value="">No project</option>'
    + projects.concat(chat?.sharedFrom && p ? [p] : []).map(x => `<option value="${x.id}"${x.id === chat?.project ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  $('chatProject').disabled = Boolean(chat?.sharedFrom); // a shared chat stays in the project it was shared in
}
$('projectBadge').addEventListener('click', () => projectOf(chat) && openProjectDialog(chat.project));
$('chatProject').addEventListener('change', () => {
  chat.project = $('chatProject').value || undefined;
  saveChat(chat, { touch: false });
  drawList(); drawProjectBits(); drawRepo(); drawGithub(); drawRoute(); drawTools(); drawHint(); drawKit(); drawEffort();
});

// ---------------------------------------------------------------------------
// Routing: each chat (or its project) can use a named strategy from the Strategy
// page, or skip routing and send everything to one model
// ---------------------------------------------------------------------------
let strategies = { profiles: [], mcpOff: [] }; // GET api/profiles, plus the default's mcpOff from api/settings

async function loadRoutings() {
  const [p, st] = await Promise.allSettled([fetch('api/profiles').then(r => r.json()), fetch('api/settings').then(r => r.json())]);
  strategies = { profiles: p.value?.profiles || [], mcpOff: st.value?.settings?.mcpOff || [], tiers: st.value?.settings?.tiers || [] };
  drawRoute(); drawTools(); drawHint(); drawEffort(); redrawQuick();
}

// Where a chat's messages go: { model } straight to one model, { profile } a
// named strategy, {} the default. `from` says whose choice it is.
function routeOf(c) {
  const p = projectOf(c);
  const own = c?.route && c.route !== 'project';
  const pick = own ? { route: c.route, model: c.model, from: 'chat' } : p?.route ? { route: p.route, model: p.model, from: 'project' } : { route: 'default', from: '' };
  if (pick.route === 'model') return pick.model?.trim() ? { model: pick.model.trim(), from: pick.from } : { from: pick.from, empty: true };
  if (pick.route === 'auto') return { auto: true, from: pick.from };
  if (pick.route?.startsWith('p:')) {
    const profile = strategies.profiles.find(x => x.id === pick.route.slice(2));
    return profile ? { profile, from: pick.from } : { from: pick.from, missing: pick.route.slice(2) };
  }
  return { from: pick.from };
}

function routeHeaders(c) {
  return { ...(c?.id ? { 'x-harness-session': `chat-${c.id}` } : {}), ...routeHeadersOf(c) };
}

function routeHeadersOf(c) {
  const r = routeOf(c);
  if (r.model) return { 'x-harness-model': r.model };
  const effort = c?.effort && c.effort !== 'auto' ? { 'x-harness-effort': c.effort } : {};
  if (r.profile) return { 'x-harness-profile': r.profile.id, ...effort };
  if (r.auto) return { 'x-harness-profile': 'auto', ...effort };
  return effort;
}

// Effort per chat: moves the Router's score, so the strategy reaches for
// cheaper or better tiers (utils/tiers.js). Sent as x-harness-effort.
const EFFORTS = [
  { id: 'min', name: 'Cheapest', note: 'Every message goes to the strategy’s cheapest model (Weak).' },
  { id: 'low', name: 'Lower', note: 'Leans cheaper: only clearly hard messages reach the better tiers.' },
  { id: 'auto', name: 'Auto', note: 'The Router decides from how hard each message looks.' },
  { id: 'high', name: 'Higher', note: 'Leans better: middling messages move up a tier.' },
  { id: 'max', name: 'Best', note: 'Every message goes to the strategy’s top tier.' },
];
function drawEffort() {
  if (!chat) return;
  const i = Math.max(0, EFFORTS.findIndex(e => e.id === (chat.effort || 'auto')));
  const e = EFFORTS[i];
  const direct = !!routeOf(chat).model;
  $('effort').value = String(i);
  $('effortName').textContent = e.name;
  $('effortNote').textContent = direct ? 'This chat goes to one model directly, so effort has no effect. Pick a strategy in Options to use it.' : e.note;
  $('effortBtn').textContent = direct ? 'Direct' : e.name;
  $('effortBtn').classList.toggle('on', !direct && e.id !== 'auto');
}
$('effortBtn').addEventListener('click', (e) => { e.stopPropagation(); drawEffort(); $('effortPop').hidden = !$('effortPop').hidden; });
$('effort').addEventListener('input', () => {
  chat.effort = EFFORTS[Number($('effort').value)].id;
  if (chat.effort === 'auto') delete chat.effort;
  saveChat(chat, { touch: false });
  drawEffort();
});
document.addEventListener('click', (e) => {
  if (!$('effortPop').hidden && !e.target.closest('#effortPop, #effortBtn')) $('effortPop').hidden = true;
});

// MCP servers the chat's strategy doesn't offer (a direct model gets the default's choice)
const routingMcpOff = (c) => routeOf(c).profile?.mcpOff || strategies.mcpOff || [];

function routeChoices(selected, first) {
  const opt = (v, label) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const missing = selected?.startsWith('p:') && !strategies.profiles.some(x => `p:${x.id}` === selected);
  return (first || '') + opt('default', 'Default strategy') + opt('auto', 'Auto: pick a strategy for each message')
    + strategies.profiles.map(x => opt(`p:${x.id}`, `Strategy: ${x.name}`)).join('')
    + (missing ? opt(selected, `${selected.slice(2)} (deleted: uses the default)`) : '')
    + opt('model', 'One model directly (no strategy)');
}

function routeLabel(r) {
  if (r.model) return `straight to ${r.model}`;
  if (r.auto) return 'Auto strategy';
  if (r.profile) return `strategy “${r.profile.name}”`;
  return 'the default strategy';
}

function drawRoute() {
  if (!chat) return;
  const p = projectOf(chat);
  const own = chat.route && chat.route !== 'project' ? chat.route : (p ? 'project' : 'default');
  const viaProject = p ? `<option value="project"${own === 'project' ? ' selected' : ''}>Same as the project (${esc(routeLabel(routeOf({ project: chat.project })))})</option>` : '';
  $('routeSel').innerHTML = routeChoices(own, viaProject);
  $('routeSel').value = own;
  $('directRow').hidden = own !== 'model';
  $('model').value = own === 'model' ? chat.model || '' : '';
  const r = routeOf(chat);
  $('routeNote').innerHTML = r.empty ? 'Type a model name.'
    : r.missing ? `The strategy “${esc(r.missing)}” was deleted, so the default is used.`
    : r.model ? 'Straight to this model, no Router.'
    : r.auto ? 'Picks the strategy that fits each message. <a href="routing.html">Set rules</a>'
    : r.profile ? `${r.profile.pin ? `Pinned to ${esc(r.profile.pin)}. ` : ''}Compression: ${['caveman', 'headroom', 'contextAnchor'].filter(k => r.profile[k]).length ? ['caveman', 'headroom', 'contextAnchor'].filter(k => r.profile[k]).map(k => ({ caveman: 'short replies', headroom: 'shrink tool results', contextAnchor: 'skip repeats' })[k]).join(', ') : 'off'}. <a href="routing.html?routing=${encodeURIComponent(r.profile.id)}">Edit it</a>`
    : '<a href="routing.html">Make strategies</a>';
}

$('routeSel').addEventListener('change', () => {
  const v = $('routeSel').value;
  if (v === 'project') delete chat.route; else chat.route = v;
  if (v === 'model' && !chat.model) chat.model = replyModel([...chat.messages].reverse().find(m => m.role === 'assistant')) || '';
  saveChat(chat, { touch: false });
  drawRoute(); drawTools(); drawHint(); drawStats(); drawEffort();
  if (v === 'model') $('model').focus();
});
$('model').addEventListener('change', () => {
  chat.model = $('model').value.trim();
  saveChat(chat, { touch: false });
  drawRoute(); drawHint(); drawStats();
});

function drawProjectRoute(p) {
  const v = p?.route || 'default';
  $('pRoute').innerHTML = routeChoices(v);
  $('pRoute').value = v;
  $('pModel').value = p?.model || '';
  $('pModelRow').hidden = v !== 'model';
}
$('pRoute').addEventListener('change', () => { $('pModelRow').hidden = $('pRoute').value !== 'model'; if (!$('pModelRow').hidden) $('pModel').focus(); });

// Tokens and cost of every saved chat in a project
function projectUsage(id) {
  let chats = 0, input = 0, output = 0, usd = 0, priced = true;
  for (const e of index.filter(x => x.project === id)) {
    const c = loadChat(e.id);
    if (!c) continue;
    chats++;
    for (const m of c.messages) {
      if (m.role !== 'assistant') continue;
      const k = usageOf(m);
      if (k) { input += k.input; output += k.output; }
      const cost = replyCost(m);
      if (cost) usd += cost.usd; else if (k) priced = false;
    }
  }
  return { chats, input, output, usd, priced };
}

let editingProject = null;
let projectColor = COLORS[0];
function drawSwatches() {
  $('pColors').innerHTML = COLORS.map(c => `<button type="button" role="radio" aria-checked="${c === projectColor}" class="sw${c === projectColor ? ' on' : ''}" data-c="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('');
}
$('pColors').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { projectColor = b.dataset.c; drawSwatches(); } });

// Sharing: who the open project is shared with. shareDraft is edited in the dialog and sent on Save.
let shareDraft = null, shareOrig = '', sharePeople = [];
const shareJson = (d) => JSON.stringify({ everyone: d.everyone, grants: [...d.grants].sort((a, b) => a.user.localeCompare(b.user)) });
function drawShare() {
  $('pShareAll').value = shareDraft.everyone;
  $('pShareList').innerHTML = shareDraft.grants.map(g => `<div class="share-row" data-user="${esc(g.user)}">
      <span class="who">${esc(g.user)}</span>
      <select data-role aria-label="What ${esc(g.user)} can do"><option value="view"${g.role === 'view' ? ' selected' : ''}>Can view</option><option value="edit"${g.role === 'edit' ? ' selected' : ''}>Can edit</option></select>
      <button type="button" class="link" data-unshare="${esc(g.user)}" aria-label="Stop sharing with ${esc(g.user)}">Remove</button></div>`).join('')
    || '<span class="muted small">Not shared with anyone by name.</span>';
  const free = sharePeople.filter(n => !shareDraft.grants.some(g => g.user === n));
  $('pSharePerson').innerHTML = free.map(n => `<option>${esc(n)}</option>`).join('') || '<option value="">No one else to add</option>';
  $('pShareAdd').disabled = !free.length;
}
async function loadShare(projectId) {
  $('pShare').hidden = true;
  shareDraft = null;
  if (!sync.on || !sync.canShare || !projectId) return;
  try {
    const [mine, people] = await Promise.all([sync.api('/shares').then(r => r.json()), sync.api('/shares/people').then(r => r.json())]);
    if (editingProject?.id !== projectId) return;
    const rows = mine.mine.filter(r => r.project_id === projectId);
    shareDraft = { everyone: rows.find(r => r.grantee === '*')?.role || '', grants: rows.filter(r => r.grantee !== '*').map(r => ({ user: r.grantee, role: r.role })) };
    shareOrig = shareJson(shareDraft);
    sharePeople = people.people || [];
    drawShare();
    $('pShare').hidden = false;
  } catch { /* sharing stays hidden if the server can't be asked */ }
}
$('pShareAll').addEventListener('change', () => { shareDraft.everyone = $('pShareAll').value; });
$('pShareAdd').addEventListener('click', () => {
  const user = $('pSharePerson').value;
  if (!user || !shareDraft) return;
  shareDraft.grants.push({ user, role: $('pShareRole').value });
  drawShare();
});
$('pShareList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-unshare]');
  if (!b) return;
  shareDraft.grants = shareDraft.grants.filter(g => g.user !== b.dataset.unshare);
  drawShare();
});
$('pShareList').addEventListener('change', (e) => {
  const row = e.target.closest('.share-row');
  const g = row && shareDraft.grants.find(x => x.user === row.dataset.user);
  if (g && e.target.matches('[data-role]')) g.role = e.target.value;
});

function openProjectDialog(id) {
  editingProject = projects.find(p => p.id === id) || sharedProjects.find(p => p.id === id) || null;
  const p = editingProject || {};
  const theirs = Boolean(editingProject?.owner); // someone else's project, shared with edit
  if (theirs && editingProject.role !== 'edit') return toast(`${editingProject.owner} shared this project for viewing only.`);
  for (const el of $('projectDialog').querySelectorAll('.own-only')) el.hidden = theirs || (el.id === 'pShare');
  $('projectDialogTitle').textContent = theirs ? `Shared by ${p.owner}` : editingProject ? 'Project settings' : 'New project';
  shareDraft = null;
  if (!theirs) loadShare(editingProject?.id);
  $('pName').value = p.name || '';
  $('pInstructions').value = p.instructions || '';
  $('pRepo').value = p.repo?.path || '';
  drawProjectRoute(editingProject);
  projectColor = p.color || COLORS[projects.length % COLORS.length];
  drawSwatches();
  const on = new Set(p.skills || []);
  $('pSkills').innerHTML = skills.map(k => `<label class="check"><input type="checkbox" value="${k.id}"${on.has(k.id) ? ' checked' : ''}> ${esc(k.name)}</label>`).join('')
    || '<span class="muted small">No skills yet. Add them from the composer’s skills button.</span>';
  $('pDelete').hidden = theirs || !editingProject;
  if (!theirs) drawProjectAgents(p.id);
  if (editingProject && !theirs) {
    const u = projectUsage(p.id);
    $('pUsage').innerHTML = `${u.chats} chat${u.chats === 1 ? '' : 's'} · ${fmtTok(u.input + u.output)} tokens (${fmtTok(u.input)} in, ${fmtTok(u.output)} out) · ${u.usd ? fmtUsd(u.usd) : 'free'}${u.priced ? '' : '+'}`;
  } else $('pUsage').textContent = '';
  $('projectDialog').showModal();
  $('pName').focus();
}
$('newProject').addEventListener('click', () => openProjectDialog(null));

// Agents (the Agents page) linked to a project: the agent keeps the project's id and name,
// so this list is read from the runner and saving updates the agents that changed.
let projectAgents = null;   // null = the runner could not be reached
async function drawProjectAgents(projectId) {
  const box = $('pAgents');
  projectAgents = null;
  box.innerHTML = '<span class="muted small">Loading…</span>';
  try {
    const res = await fetch('api/agents');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || '');
    projectAgents = body.agents;
  } catch {
    box.innerHTML = '<span class="muted small">The task runner is not running, so agents can’t be linked now (npm run all starts it).</span>';
    return;
  }
  box.innerHTML = projectAgents.map(a => {
    const other = a.project && a.project.id !== projectId ? projects.find(x => x.id === a.project.id)?.name || a.project.name || 'another project' : '';
    return `<label class="check" title="${esc(a.repo)}"><input type="checkbox" value="${esc(a.id)}"${projectId && a.project?.id === projectId ? ' checked' : ''}> ${esc(a.name)}${other ? ` <span class="muted small">(now in ${esc(other)})</span>` : ''}</label>`;
  }).join('') || '<span class="muted small">No agents yet. Make one on the <a href="agents.html">Agents page</a>.</span>';
}
// link or unlink the agents ticked in the dialog (best effort: the project saves either way)
async function saveProjectAgents(p) {
  if (!projectAgents) return;
  const want = new Set([...$('pAgents').querySelectorAll('input:checked')].map(i => i.value));
  const patches = projectAgents.filter(a => {
    const is = a.project?.id === p.id;
    return want.has(a.id) ? (!is || a.project.name !== p.name) : is;
  });
  for (const a of patches) {
    try {
      const res = await fetch(`api/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: want.has(a.id) ? { id: p.id, name: p.name } : null }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) { toast(`Could not update the agent ${a.name}: ${err.message}`); }
  }
}

$('projectForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const name = $('pName').value.trim();
  if (!name) return $('pName').focus();
  if (editingProject?.owner) { // someone else's project: only its name, colour and instructions can change
    const p = editingProject;
    try {
      const r = await sync.api(`/shared/${encodeURIComponent(p.owner)}/projects/${p.id}`, { method: 'PUT', body: { name, color: projectColor, instructions: $('pInstructions').value } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      Object.assign(p, j.project);
    } catch (err) { return toast(`Could not save the shared project: ${err.message}`); }
    $('projectDialog').close();
    drawSide(); drawHint();
    return;
  }
  if (shareDraft && shareJson(shareDraft) !== shareOrig) {
    try {
      const r = await sync.api(`/shares/${editingProject.id}`, { method: 'PUT', body: { grants: shareDraft.grants, everyone: shareDraft.everyone } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 404 ? 'this project has not reached the server yet, try again in a moment' : (j.error || `HTTP ${r.status}`));
      toast('Sharing saved.');
    } catch (err) { return toast(`Could not save sharing: ${err.message}`); }
  }
  const p = editingProject || { id: uid(), created: Date.now() };
  const path = $('pRepo').value.trim();
  if (path !== (p.repo?.path || '')) {
    if (!path) delete p.repo;
    else {
      $('pSave').disabled = true;
      try {
        const res = await fetch('api/repo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        p.repo = { path: j.path, name: j.name, branch: j.branch, head: j.head, remote: j.remote };
      } catch (err) {
        toast(`Could not link the repo: ${err.message}`);
        return;
      } finally {
        $('pSave').disabled = false;
      }
    }
  }
  Object.assign(p, { name, color: projectColor, instructions: $('pInstructions').value, skills: [...$('pSkills').querySelectorAll('input:checked')].map(i => i.value) });
  const route = $('pRoute').value;
  if (route === 'default') delete p.route; else p.route = route;
  if (route === 'model') p.model = $('pModel').value.trim(); else delete p.model;
  if (!editingProject) projects.push(p);
  saveProjects();
  saveProjectAgents(p);
  $('projectDialog').close();
  if (!editingProject) {
    // a new project opens with a fresh chat in it
    setScope(p.id);
    if (!chat.messages.length) { chat.project = p.id; drawProjectBits(); } else openChat(null);
  }
  drawSide(); drawRepo(); drawGithub(); drawRoute(); drawTools(); drawHint(); drawKit(); drawEffort();
});
$('pDelete').addEventListener('click', async () => {
  const p = editingProject;
  if (!p) return;
  const n = index.filter(e => e.project === p.id).length;
  if (!await ui.confirm(`Delete the project “${p.name}”?${n ? ` Its ${n} chat${n === 1 ? '' : 's'} stay, with no project.` : ''}`)) return;
  for (const e of index.filter(x => x.project === p.id)) {
    const c = loadChat(e.id);
    if (c) { delete c.project; saveChat(c, { touch: false }); }
  }
  if (chat?.project === p.id) delete chat.project;
  projects = projects.filter(x => x.id !== p.id);
  saveProjects();
  fetch('api/agents').then(r => r.json()).then(({ agents = [] }) => agents.filter(a => a.project?.id === p.id).forEach(a =>
    fetch(`api/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: null }) }))).catch(() => {});
  if (scope === p.id) setScope('');
  $('projectDialog').close();
  drawSide(); drawRepo(); drawHint();
});

// ---------------------------------------------------------------------------
// Skills: named instructions, turned on per chat or per project
// ---------------------------------------------------------------------------
const STARTER_SKILLS = [
  { name: 'code-reviewer', description: 'Review code or a diff for bugs, risks and unclear parts', body: 'Review the code the user shares. List real problems first, most serious first, each with the line or function, what goes wrong and a fix. Then note smaller style points briefly. Say plainly when the code looks fine.' },
  { name: 'explain-simply', description: 'Explain a topic to someone new to it', body: 'Explain in plain words for someone new to the topic. Start with a one-sentence answer, then an everyday example, then the details. Define any jargon the first time it appears.' },
  { name: 'brief', description: 'Short, direct answers', body: 'Answer in as few words as the question allows. Lead with the answer. No preamble, no summary at the end.' },
];
let editingSkill = null;

function drawKit() {
  if (!chat) return;
  const mine = new Set(chat.skills || []);
  const fromProject = new Set(projectOf(chat)?.skills || []);
  $('kitSkills').innerHTML = skills.map(k => `<li><label class="check" title="${esc(k.description || k.body.slice(0, 160))}">
      <input type="checkbox" data-skill="${k.id}"${mine.has(k.id) || fromProject.has(k.id) ? ' checked' : ''}${fromProject.has(k.id) ? ' disabled' : ''}>
      <span><b>${esc(k.name)}</b>${fromProject.has(k.id) ? ' <span class="tag">project</span>' : ''}<br><span class="muted small">${esc(k.description || '')}</span></span></label></li>`).join('')
    || '<li class="muted small">No skills yet. Manage skills to add some.</li>';
  const repo = repoOf(chat);
  const shellOn = $('shellInRepo').checked && (toolInfo?.shellDefinitions || []).length > 0;
  $('kitShell').checked = shellOn;
  $('kitShell').disabled = !repo || !(toolInfo?.shellDefinitions || []).length;
  $('kitRepo').innerHTML = repo
    ? `Git repo <b>${esc(repo.name)}</b> is linked${chat.repo ? '' : ' through the project'}: the model can ${shellOn ? 'read it and run commands in it' : 'read it'}.`
    : 'Link a git repo under Options to let the model read it.';
  $('kitBtn').classList.toggle('on', skillsOf(chat).length > 0);
}
$('kitBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleKit(); });
function toggleKit(open = $('kit').hidden) {
  $('kit').hidden = !open;
  if (open) drawKit();
}
document.addEventListener('click', (e) => {
  if (!$('kit').hidden && !e.target.closest('#kit, #kitBtn')) $('kit').hidden = true;
  if (!$('usagePop').hidden && !e.target.closest('#usagePop, #chatStats')) $('usagePop').hidden = true;
});
$('kitSkills').addEventListener('change', (e) => {
  const box = e.target.closest('[data-skill]');
  if (!box) return;
  const on = new Set(chat.skills || []);
  if (box.checked) on.add(box.dataset.skill); else on.delete(box.dataset.skill);
  chat.skills = [...on];
  saveChat(chat, { touch: false });
  drawKit(); drawHint(); drawList();
});
$('skillTool').checked = !!prefs.skillTool;
$('skillTool').addEventListener('change', () => { prefs.skillTool = $('skillTool').checked; store.set(PREF_KEY, prefs); drawHint(); });
// the panel's shell box is the same preference as the options' one
$('kitShell').addEventListener('change', () => {
  $('shellInRepo').checked = $('kitShell').checked;
  prefs.shellInRepo = $('kitShell').checked;
  store.set(PREF_KEY, prefs);
  drawRepo(); drawKit(); drawHint();
});
// the panel keeps to skills and commands; servers stay under Options
// a / in an empty box lists the commands (drawSlash, above)

function drawSkillIndex() {
  $('skillIndex').innerHTML = skills.map(k => `<li data-kid="${k.id}" class="${k === editingSkill ? 'on' : ''}">${esc(k.name || '(no name)')}</li>`).join('')
    || '<li class="muted small">No skills yet.</li>';
  $('skillEdit').hidden = !editingSkill;
  if (editingSkill) {
    $('kName').value = editingSkill.name; $('kDesc').value = editingSkill.description || ''; $('kBody').value = editingSkill.body || '';
  }
}
function openSkills() {
  if (!skills.length) { skills = STARTER_SKILLS.map(k => ({ id: uid(), ...k })); saveSkills(); }
  editingSkill = skills[0] || null;
  drawSkillIndex();
  $('kit').hidden = true;
  $('skillsDialog').showModal();
}
$('manageSkills').addEventListener('click', openSkills);
$('skillIndex').addEventListener('click', (e) => {
  const li = e.target.closest('[data-kid]');
  if (li) { editingSkill = skills.find(k => k.id === li.dataset.kid); drawSkillIndex(); }
});
$('skillAdd').addEventListener('click', () => {
  editingSkill = { id: uid(), name: `skill-${skills.length + 1}`, description: '', body: '' };
  skills.push(editingSkill);
  saveSkills(); drawSkillIndex(); $('kName').select();
});
for (const [id, key] of [['kName', 'name'], ['kDesc', 'description'], ['kBody', 'body']]) {
  $(id).addEventListener('input', () => {
    if (!editingSkill) return;
    editingSkill[key] = key === 'name' ? $(id).value.trim().replace(/\s+/g, '-') : $(id).value;
    saveSkills();
    if (key === 'name') for (const li of $('skillIndex').querySelectorAll('li.on')) li.textContent = editingSkill.name || '(no name)';
  });
}
$('skillDelete').addEventListener('click', async () => {
  if (!editingSkill || !await ui.confirm(`Delete the skill “${editingSkill.name}”?`)) return;
  const id = editingSkill.id;
  skills = skills.filter(k => k.id !== id);
  for (const p of projects) if (p.skills) p.skills = p.skills.filter(x => x !== id);
  saveSkills(); saveProjects();
  editingSkill = skills[0] || null;
  drawSkillIndex();
});
$('skillsDialog').addEventListener('close', () => { skills = skills.filter(k => k.name || k.body); saveSkills(); drawKit(); drawHint(); });

// ---------------------------------------------------------------------------
// Commands: a name, what it does, the model or strategy its turn goes to, its
// effort, and the message it sends ({args} becomes what you type after it)
// ---------------------------------------------------------------------------
const STARTER_COMMANDS = [{
  name: 'advisor',
  description: 'A second opinion from another model',
  model: '',
  effort: 'max',
  body: 'Give a second opinion, as a careful reviewer: what is wrong, missing or risky first, then what you would do instead. Be brief and concrete, and say plainly when it looks fine.\n\nWhat the person is asking now:\n{args}',
}];
let editingCommand = null;
const saveCommands = () => store.set(COMMANDS_KEY, commands);

function drawCommandIndex() {
  $('commandIndex').innerHTML = commands.map(c => `<li data-cid="${c.id}" class="${c === editingCommand ? 'on' : ''}">/${esc(c.name || '(no name)')}</li>`).join('')
    || '<li class="muted small">No commands yet.</li>';
  $('commandEdit').hidden = !editingCommand;
  if (editingCommand) {
    $('cName').value = editingCommand.name || '';
    $('cDesc').value = editingCommand.description || '';
    $('cModel').value = editingCommand.model || '';
    $('cEffort').value = editingCommand.effort || '';
    $('cBody').value = editingCommand.body || '';
  }
}

function openCommands() {
  if (!commands.length) { commands = STARTER_COMMANDS.map(c => ({ id: uid(), ...c })); saveCommands(); }
  editingCommand = commands[0] || null;
  drawCommandIndex();
  $('kit').hidden = true;
  $('commandsDialog').showModal();
}

// a / with no command by that name offers to make it
function newCommand(name) {
  if (!commands.length) commands = STARTER_COMMANDS.map(c => ({ id: uid(), ...c }));
  editingCommand = { id: uid(), name: name || `command-${commands.length + 1}`, description: '', model: '', effort: '', body: '' };
  commands.push(editingCommand);
  saveCommands();
  drawCommandIndex();
  $('kit').hidden = true;
  $('commandsDialog').showModal();
  $('cName').select();
}

$('manageCommands').addEventListener('click', openCommands);
$('commandIndex').addEventListener('click', (e) => {
  const li = e.target.closest('[data-cid]');
  if (li) { editingCommand = commands.find(c => c.id === li.dataset.cid); drawCommandIndex(); }
});
$('commandAdd').addEventListener('click', () => {
  editingCommand = { id: uid(), name: `command-${commands.length + 1}`, description: '', model: '', effort: '', body: '' };
  commands.push(editingCommand);
  saveCommands(); drawCommandIndex(); $('cName').select();
});
for (const [id, key] of [['cName', 'name'], ['cDesc', 'description'], ['cModel', 'model'], ['cEffort', 'effort'], ['cBody', 'body']]) {
  $(id).addEventListener('input', () => {
    if (!editingCommand) return;
    editingCommand[key] = key === 'name' ? $(id).value.trim().replace(/[\s/]+/g, '-') : $(id).value;
    saveCommands();
    if (key === 'name') drawCommandIndex();
  });
}
$('commandDelete').addEventListener('click', async () => {
  if (!editingCommand || !await ui.confirm(`Delete the command “/${editingCommand.name}”?`)) return;
  commands = commands.filter(c => c !== editingCommand);
  saveCommands();
  editingCommand = commands[0] || null;
  drawCommandIndex();
});
$('commandsDialog').addEventListener('close', () => {
  commands = commands.filter(c => c.name || c.body);
  saveCommands();
  drawHint();
});

// Claude Code's own commands and skills (.claude/commands, .claude/skills), one click to copy in
let claudeKit = null;
async function drawImport(kind) {
  const ul = $(kind === 'command' ? 'importCommandsList' : 'importSkillsList');
  if (!claudeKit) {
    ul.innerHTML = '<li class="muted small">Looking…</li>';
    try {
      const r = await fetch('/ui/api/claude-kit', { credentials: 'same-origin' });
      claudeKit = r.ok ? (await r.json()).items : [];
      if (!r.ok) ul.innerHTML = `<li class="muted small">${esc((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)}</li>`;
    } catch { claudeKit = []; }
  }
  const have = new Set((kind === 'command' ? commands : skills).map(x => x.name.toLowerCase()));
  const items = claudeKit.filter(i => i.kind === kind);
  ul.innerHTML = items.map((i, n) => `<li class="muted small" title="${esc(i.body.slice(0, 300))}">${kind === 'command' ? '/' : ''}${esc(i.name)} <span class="muted">(${esc(i.source)})</span>${i.description ? ` · ${esc(i.description)}` : ''} <button type="button" class="mini" data-import="${n}"${have.has(i.name.toLowerCase()) ? ' disabled' : ''}>${have.has(i.name.toLowerCase()) ? 'Added' : 'Add'}</button></li>`).join('')
    || '<li class="muted small">Nothing found in .claude/commands or .claude/skills (here or in your home folder).</li>';
}
for (const [id, kind] of [['importCommands', 'command'], ['importSkills', 'skill']]) {
  $(id).addEventListener('toggle', () => { if ($(id).open) drawImport(kind); });
  $(`${id}List`).addEventListener('click', (e) => {
    const b = e.target.closest('[data-import]');
    if (!b) return;
    const i = claudeKit.filter(x => x.kind === kind)[Number(b.dataset.import)];
    if (kind === 'command') {
      commands.push({ id: uid(), name: i.name, description: i.description, model: '', effort: '', body: i.body });
      saveCommands(); editingCommand = commands[commands.length - 1]; drawCommandIndex();
    } else {
      skills.push({ id: uid(), name: i.name, description: i.description, body: i.body });
      saveSkills(); editingSkill = skills[skills.length - 1]; drawSkillIndex();
    }
    drawImport(kind);
  });
}

// ---------------------------------------------------------------------------
// Scheduled messages: sent while this page is open in a tab; a run missed
// while it was closed happens when it opens
// ---------------------------------------------------------------------------
let editingSchedule = null;
const pad = (n) => String(n).padStart(2, '0');
const localInput = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// The next time after `from` that a schedule starting at `start` repeats (ui/schedule.js, shared with the server)
const myZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
const nextRun = (start, repeat, from = Date.now(), tz = myZone) => Schedule.nextRun(start, repeat, from, tz);

function openScheduleDialog(id) {
  editingSchedule = schedules.find(s => s.id === id) || null;
  const s = editingSchedule || {};
  $('schedDialogTitle').textContent = editingSchedule ? 'Scheduled message' : 'Schedule a message';
  $('sName').value = s.name || '';
  $('sPrompt').value = s.prompt || '';
  $('sWhen').value = localInput(s.next || s.start || Date.now() + 10 * 60000);
  $('sRepeat').value = s.repeat || 'daily';
  const here = index.some(e => e.id === chat?.id) ? chat : null;
  const opts = ['<option value="new">A new chat each time</option>']
    .concat(projects.map(p => `<option value="new:${p.id}">A new chat each time, in ${esc(p.name)}</option>`))
    .concat(index.slice(0, 30).map(e => `<option value="chat:${e.id}">Chat: ${esc(e.title)}</option>`));
  $('sTarget').innerHTML = opts.join('');
  $('sTarget').value = s.target || (scope ? `new:${scope}` : here ? 'new' : 'new');
  $('sDelete').hidden = $('sRunNow').hidden = !editingSchedule;
  $('schedDialog').showModal();
  (s.prompt ? $('sName') : $('sPrompt')).focus();
}
$('newSchedule').addEventListener('click', () => openScheduleDialog(null));
$('schedForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const prompt = $('sPrompt').value.trim();
  const start = new Date($('sWhen').value).getTime();
  if (!prompt) return $('sPrompt').focus();
  if (!start) return $('sWhen').focus();
  const s = editingSchedule || { id: uid() };
  Object.assign(s, { name: $('sName').value.trim(), prompt, repeat: $('sRepeat').value, start, target: $('sTarget').value, tz: myZone });
  s.next = s.repeat === 'once' ? start : nextRun(start, s.repeat, Date.now() - 1, s.tz);
  if (!editingSchedule) schedules.push(s);
  saveSchedules();
  $('schedDialog').close();
  drawSchedules();
  toast(`Scheduled for ${new Date(s.next).toLocaleString()}.`);
});
$('sDelete').addEventListener('click', async () => {
  if (!editingSchedule || !await ui.confirm('Delete this scheduled message?')) return;
  schedules = schedules.filter(s => s !== editingSchedule);
  saveSchedules(); $('schedDialog').close(); drawSchedules();
});
$('sRunNow').addEventListener('click', () => { const s = editingSchedule; $('schedDialog').close(); if (s) runSchedule(s, true); });

function runSchedule(s, manual = false) {
  let c;
  if (s.target?.startsWith('chat:')) c = loadChat(s.target.slice(5));
  if (c && running.has(c.id)) return false; // try again on the next check
  if (!c) {
    c = newChatObject();
    if (s.target?.startsWith('new:') && projects.some(p => p.id === s.target.slice(4))) c.project = s.target.slice(4);
    c.title = `${s.name || 'Scheduled'} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    c.scheduled = s.id;
    cache.set(c.id, c);
  }
  c.messages.push({ id: uid(), role: 'user', content: s.prompt, time: Date.now(), scheduled: true });
  s.last = Date.now();
  if (!manual) s.next = nextRun(s.start, s.repeat, Date.now(), s.tz || myZone);
  saveSchedules();
  runReply(c);
  drawSchedules();
  toast(`Sent the scheduled message${s.name ? ` “${s.name}”` : ''}.`);
  return true;
}
function checkSchedules() {
  if (sync.serverSchedules) return; // the server sends them, with or without this page
  let changed = false;
  for (const s of schedules) if (s.next && s.next <= Date.now()) changed = runSchedule(s) || changed;
  if (changed) drawSchedules();
}
setInterval(checkSchedules, 15000);

// ---------------------------------------------------------------------------
// This chat's tokens and cost, opened from the numbers in the top bar
// ---------------------------------------------------------------------------
function drawUsagePop() {
  // a reply still arriving counts what it has reported so far
  const replies = chat.messages.filter(m => m.role === 'assistant');
  const rows = replies.map((m, i) => {
    const k = usageOf(m) || { input: 0, output: 0, exact: true };
    return { i: i + 1, model: replyModel(m) || '?', input: k.input, output: k.output, exact: k.exact, cost: replyCost(m) };
  });
  const approx = rows.some(r => !r.exact) ? '~' : '';
  const byModel = new Map();
  for (const r of rows) {
    const t = byModel.get(r.model) || { n: 0, input: 0, output: 0, usd: 0, free: true, unknown: false };
    t.n++; t.input += r.input; t.output += r.output;
    if (!r.cost) t.unknown = true; else if (!r.cost.free) { t.free = false; t.usd += r.cost.usd; }
    byModel.set(r.model, t);
  }
  const tot = rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, usd: a.usd + (r.cost?.usd || 0) }), { input: 0, output: 0, usd: 0 });
  const max = Math.max(1, ...rows.map(r => r.input + r.output));
  const next = requestTokens();
  const model = routeOf(chat).model || replyModel(replies[replies.length - 1]);
  const ctxMax = modelInfo[model]?.maxInput;
  const p = projectOf(chat);
  const pu = p ? projectUsage(p.id) : null;
  $('usagePop').innerHTML = `
    <div class="up-tiles">
      <div><b>${approx}${fmtTok(tot.input + tot.output)}</b><span>tokens</span></div>
      <div><b>${fmtTok(tot.input)}</b><span>sent</span></div>
      <div><b>${fmtTok(tot.output)}</b><span>written</span></div>
      <div><b>${tot.usd ? fmtUsd(tot.usd) : 'free'}</b><span>cost</span></div>
    </div>
    <div class="small muted">Sent counts every request this chat made: each reply re-sends the whole history, so it grows faster than the chat.${approx ? ' Values marked ~ are estimated: the provider sent no counts.' : ''}</div>
    ${rows.length ? `<div class="up-head">Each reply <span class="muted">sent · written</span></div>
    <div class="up-bars">${rows.map(r => `<div class="up-bar" title="Reply ${r.i} · ${esc(r.model)}\n${r.exact ? '' : '~'}${r.input.toLocaleString()} in · ${r.exact ? '' : '~'}${r.output.toLocaleString()} out${r.cost ? ` · ${r.cost.free ? 'free' : fmtUsd(r.cost.usd)}` : ''}">
      <i class="in" style="height:${100 * r.input / max}%"></i><i class="out" style="height:${100 * r.output / max}%"></i></div>`).join('')}</div>
    <div class="up-head">By model</div>
    <table class="up-table"><tbody>${[...byModel].map(([k, t]) => `<tr><td><code>${esc(k)}</code></td><td>${t.n}×</td><td>${fmtTok(t.input)} / ${fmtTok(t.output)}</td><td>${t.free && !t.unknown ? '<span class="ok">free</span>' : `${fmtUsd(t.usd)}${t.unknown ? '+' : ''}`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No replies yet.</p>'}
    <div class="up-head">Next message</div>
    <div class="small">About ${next.toLocaleString()} tokens${ctxMax ? ` of ${esc(model)}'s ${ctxMax.toLocaleString()}` : ''}${requestPrompt().images ? `, plus ${requestPrompt().images} image${requestPrompt().images === 1 ? '' : 's'}` : ''}.</div>
    ${ctxMax ? `<div class="up-meter"><i style="width:${Math.min(100, 100 * next / ctxMax)}%"></i></div>` : ''}
    ${pu ? `<div class="up-head">Project “${esc(p.name)}”</div><div class="small">${pu.chats} chats · ${fmtTok(pu.input + pu.output)} tokens · ${pu.usd ? fmtUsd(pu.usd) : 'free'}${pu.priced ? '' : '+'}</div>` : ''}
    <a class="small" href="usage.html">Every client's usage and costs →</a>`;
}
$('chatStats').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('usagePop').hidden;
  $('usagePop').hidden = !open;
  if (open) drawUsagePop();
});

// ---------------------------------------------------------------------------
// Prompt cache timers: how long each model this chat used keeps its cache
// ---------------------------------------------------------------------------
// Each request to a model restarts that model's cache clock, so the last one
// to each model is kept on the chat: c.caches[model] = { at, read, write, long, prompt }
function noteCache(c, tr) {
  const model = tr.answered?.servedBy || tr.routed?.model;
  const u = Tokens.usage(tr.usage);
  if (!model || !u) return;
  (c.caches ||= {})[model] = { at: tr.start, read: u.cacheRead, write: u.cacheWrite, long: 0, prompt: u.input };
  if (c === chat) drawCacheTimer();
}

const cacheOf = (caches, model) => {
  const rule = CacheTimer.cacheRule(modelInfo[model]);
  return { model, rule, entry: caches[model], ...CacheTimer.cacheState(caches[model], rule) };
};
const cacheLeft = (s) => `${s.minimum ? '≥ ' : ''}${CacheTimer.fmtLeft(s.left)}`;
// the model a chat used last: the one the next message most likely goes to
const latestCache = (caches) => Object.keys(caches || {}).sort((a, b) => caches[b].at - caches[a].at)[0];
// warm, soon (under a minute or a fifth of its time left) or expired, for colours
const cacheTone = (s) => s.state !== 'warm' ? s.state : s.left < Math.max(60000, s.ttl / 5) ? 'soon' : 'warm';

// Top bar: the cache of the model the next message goes to (or the last one used)
function drawCacheTimer() {
  const el = $('cacheTimer');
  const models = Object.keys(chat?.caches || {});
  if (!models.length) { el.hidden = true; $('cachePop').hidden = true; return; }
  const pinned = routeOf(chat).model;
  const model = chat.caches[pinned] ? pinned : latestCache(chat.caches);
  const s = cacheOf(chat.caches, model);
  const warmOthers = models.filter(m => m !== model && cacheOf(chat.caches, m).state === 'warm').length;
  const ka = keepAliveFor(chat);
  el.hidden = false;
  el.className = `cache-timer ${cacheTone(s)}`;
  const text = s.state === 'warm' ? cacheLeft(s) : s.state === 'expired' ? 'expired' : s.state === 'none' ? 'not cached' : 'cache ?';
  el.innerHTML = `${ICONS.clock}<span>${text}</span>${ka.active ? `<span class="ka" title="Kept warm">${ICONS.retry}</span>` : ''}${warmOthers ? `<small>+${warmOthers}</small>` : ''}`;
  el.title = `Prompt cache for ${model} (${s.rule.provider})\n${
    s.state === 'warm' ? `Expires in ${cacheLeft(s)} unless you send again; each message restarts the clock.`
    : s.state === 'expired' ? 'Expired: the next message pays full price for the whole prompt again.'
    : s.state === 'none' ? s.why : s.rule.note}${ka.active ? '\nKept warm: a tiny request goes out before it expires.' : ''}${warmOthers ? `\n${warmOthers} other model${warmOthers > 1 ? 's' : ''} in this chat still cached.` : ''}\nClick for every model in this chat.`;
  if (!$('cachePop').hidden) drawCachePop();
}

function drawCachePop() {
  const rows = Object.keys(chat?.caches || {}).map(m => cacheOf(chat.caches, m)).sort((a, b) => b.entry.at - a.entry.at);
  const status = (s) => s.state === 'warm' ? `<b class="${cacheTone(s) === 'soon' ? 'warn' : 'ok'}">${cacheLeft(s)}</b><span class="muted"> left</span>`
    : s.state === 'expired' ? '<span class="bad">expired</span>'
    : s.state === 'none' ? '<span class="muted">not cached</span>' : '<span class="muted">unknown</span>';
  const ka = keepAliveFor(chat);
  const st = chat.keepAliveStats;
  const mode = chat.keepAlive || 'auto';
  $('cachePop').innerHTML = `
    <div class="up-head">Keep this chat's cache warm</div>
    <div class="seg" role="group" aria-label="Keep warm">${['auto', 'on', 'off'].map(v => `<button type="button" data-ka="${v}" class="${mode === v ? 'on' : ''}">${{ auto: 'Auto', on: 'On', off: 'Off' }[v]}</button>`).join('')}</div>
    <div class="small muted">${esc(ka.why)}</div>
    <label class="small ka-limit">Stop after <select id="kaIdle">${[10, 20, 30, 45, 60].map(n => `<option value="${n}"${n === keepAliveIdleMin() ? ' selected' : ''}>${n} min</option>`).join('')}</select> without a message (every chat)</label>
    ${st?.count ? `<div class="small muted">${st.count} keep-alive request${st.count > 1 ? 's' : ''} in this chat · ${st.usd ? `${st.estimated ? '≈ ' : ''}${fmtUsd(st.usd)}` : 'free'}</div>` : ''}
    <div class="up-head">Prompt cache by model</div>
    ${rows.map(s => {
      const pct = s.state === 'warm' ? 100 * s.left / s.ttl : 0;
      const hit = s.entry.read || s.entry.write
        ? `last request: ${fmtTok(s.entry.read)} read from cache${s.entry.write ? `, ${fmtTok(s.entry.write)} written` : ''} of ${fmtTok(s.entry.prompt)}`
        : `last request: ${fmtTok(s.entry.prompt)} tokens, none reported cached`;
      return `<div class="cp-row ${cacheTone(s)}">
        <div class="cp-top"><code>${esc(s.model)}</code><span class="cp-left">${status(s)}</span></div>
        ${s.ttl ? `<div class="up-meter"><i style="width:${pct}%"></i></div>` : ''}
        <div class="small muted">${esc(s.rule.provider)} · sent ${fmtAgo(s.entry.at)} · ${hit}</div>
        <div class="small muted">${esc(s.state === 'none' ? s.why : s.rule.note)}</div>
      </div>`;
    }).join('')}
    <div class="small muted">Timers count from when each request was sent. Sending again before one runs out restarts it.</div>`;
}
const fmtAgo = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

$('cacheTimer').addEventListener('click', (e) => {
  e.stopPropagation();
  $('cachePop').hidden = !$('cachePop').hidden;
  if (!$('cachePop').hidden) { $('usagePop').hidden = true; drawCachePop(); }
});
$('cachePop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ka]');
  if (!b) return;
  chat.keepAlive = b.dataset.ka === 'auto' ? undefined : b.dataset.ka;
  saveChat(chat, { touch: false });
  drawCacheTimer();
});
$('cachePop').addEventListener('change', (e) => {
  if (e.target.id === 'kaIdle') { store.set(KEEPALIVE_KEY, Number(e.target.value)); drawCacheTimer(); }
});
document.addEventListener('click', (e) => {
  // composedPath: a click on a control the popover just redrew is still inside it
  if (!$('cachePop').hidden && !e.composedPath().some(n => n === $('cachePop') || n === $('cacheTimer'))) $('cachePop').hidden = true;
});
// before the keyboard handler below, so Esc closes this and doesn't stop a reply
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('cachePop').hidden) { $('cachePop').hidden = true; e.stopImmediatePropagation(); }
});

// Sidebar: a dot on each chat with its last model's cache, so the ones about
// to go cold stand out. Updated in place (the list redraws without it).
function drawCacheDots() {
  for (const li of $('chatList').querySelectorAll('li[data-id]')) {
    const caches = (cache.get(li.dataset.id) || index.find(e => e.id === li.dataset.id))?.caches;
    const model = latestCache(caches);
    const s = model ? cacheOf(caches, model) : null;
    const tone = s && (s.state === 'warm' || s.state === 'expired') ? cacheTone(s) : '';
    let dot = li.querySelector('.cache-dot');
    if (!tone) { dot?.remove(); continue; }
    if (!dot) { dot = document.createElement('i'); li.querySelector('.ct')?.before(dot); }
    const kept = keepAliveFor(cache.get(li.dataset.id)).active;
    dot.className = `cache-dot ${tone}${kept ? ' kept' : ''}`;
    dot.title = s.state === 'warm' ? `${model} cached, ${cacheLeft(s)} left${kept ? ' (kept warm)' : ''}` : `${model} cache expired`;
  }
}
new MutationObserver(drawCacheDots).observe($('chatList'), { childList: true });

// ---------------------------------------------------------------------------
// Keep-alive: a tiny request to the same model, with the same prompt, shortly
// before its cache expires, so the next real message reads the cache instead
// of paying for the whole prompt again. Each one costs a cache read of the
// prompt (about a tenth of its price on Claude), so it stops after a while
// without messages. Runs only while a Bright Chat tab is open.
// ---------------------------------------------------------------------------
const KEEPALIVE_KEY = 'harness-keepalive-idle';
const keepAliveIdleMin = () => store.get(KEEPALIVE_KEY, 30);
const PING = 'Keep-alive: reply with just OK.';
const pinging = new Set();

// Whether a chat's last model is being kept warm, and why (or why not).
// Auto starts once a chat has more than one message from you.
function keepAliveFor(c) {
  if (!c) return { active: false, why: '' };
  const mode = c.keepAlive || 'auto';
  const model = latestCache(c.caches);
  const s = model ? cacheOf(c.caches, model) : null;
  const info = modelInfo[model];
  const asked = c.messages.filter(m => m.role === 'user');
  const lastAsk = Math.max(0, ...asked.map(m => m.time || 0));
  const idle = Date.now() - lastAsk > keepAliveIdleMin() * 60000;
  const no = (why) => ({ active: false, why });
  if (mode === 'off') return no('Off: the cache expires on its own.');
  if (!s) return no('Nothing cached yet.');
  if (s.rule.ttl == null) return no(`${s.rule.provider} doesn't say how long it caches, so there's nothing to time.`);
  if (info?.free || !info || info.inputCost == null) return no(`${model} ${info?.free ? 'is free' : 'has no known price'}, so keeping it warm saves nothing.`);
  if (s.state === 'none') return no(s.why);
  if (s.state === 'expired') return no('The cache already expired; your next message caches it again.');
  if (mode === 'auto' && asked.length < 2) return no('Auto: starts after your second message in this chat.');
  if (idle) return no(`Paused: no message from you for ${keepAliveIdleMin()} minutes.`);
  return { active: true, model, s, why: `${mode === 'auto' ? 'Auto: on' : 'On'}. A tiny request goes to ${model} about 45 s before its cache expires, until ${keepAliveIdleMin()} min after your last message. Each one costs about a cache read of the prompt.` };
}

// Same messages, tools, routing (its transforms shape the prompt) and model
// as the chat's next request, plus a short question that isn't kept; the
// cache restarts from this request
async function keepAlive(c, model) {
  pinging.add(c.id);
  const tr = { start: Date.now(), answered: { servedBy: model } };
  try {
    const tools = activeTools(c);
    const body = { model: 'auto', messages: [...apiMessages(c, c.messages.length), { role: 'user', content: PING }], stream: false, max_tokens: 16 };
    if (tools.length) body.tools = tools;
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...routeHeaders(c), 'x-harness-model': model, 'x-harness-cache': 'auto', 'x-harness-request-id': `keepalive-${c.id}-${uid()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tr.usage = (await res.json()).usage || null;
    const headerCost = parseFloat(res.headers.get('x-litellm-response-cost')) || 0;
    const st = (c.keepAliveStats ||= { count: 0, usd: 0 });
    st.count++;
    const cost = pingCost(Tokens.usage(tr.usage), headerCost, model);
    if (cost) { st.usd += cost.usd; st.estimated ||= cost.estimated; }
    noteCache(c, tr);
    saveChat(c, { touch: false });
  } catch (err) {
    console.warn(`Keep-alive for "${chatTitle(c)}" failed: ${err.message}`);
    (c.keepAliveStats ||= { count: 0, usd: 0 }).failed = Date.now();
  } finally {
    pinging.delete(c.id);
  }
}

// What a keep-alive cost: the provider's figure, else its tokens at the price
// list's cache prices (ui/costs.js)
function pingCost(k, headerCost, model) {
  if (typeof k?.cost === 'number') return { usd: k.cost };
  if (headerCost > 0) return { usd: headerCost };
  const info = modelInfo[model];
  if (!k || info?.inputCost == null) return null;
  return { usd: Costs.rowCost(k, info).cost, estimated: !k.exact };
}

function checkKeepAlive() {
  for (const e of index) {
    if (!e.caches || running.has(e.id) || pinging.has(e.id)) continue;
    const c = loadChat(e.id);
    // a failed one waits out its cache rather than retrying every second
    if (!c || Date.now() - (c.keepAliveStats?.failed || 0) < 5 * 60000) continue;
    const ka = keepAliveFor(c);
    if (ka.active && ka.s.left < 45000) keepAlive(c, ka.model);
  }
}

setInterval(() => { drawCacheTimer(); drawCacheDots(); checkKeepAlive(); }, 1000);

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openChat(null); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setSide(true); $('search').focus(); $('search').select(); }
  else if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); $('mic').click(); }
  else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepChat(e.key === 'ArrowUp' ? -1 : 1); }
  else if (e.key === 'Escape') {
    if (!$('kit').hidden || !$('usagePop').hidden) { $('kit').hidden = $('usagePop').hidden = true; }
    else if (speech.current) speech.stop();
    else if (running.has(chat.id)) running.get(chat.id).controller.abort();
    else if (narrow() && panelOpen) setSide(false);
  }
});
window.addEventListener('beforeunload', saveDraft);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
fetch('api/models').then(r => r.json()).then(({ models }) => {
  $('models').innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
  gatewayModels = models;
  redrawQuick();
}).catch(() => {});
fetch('api/model-stats').then(r => r.json()).then(({ models }) => { quickStats = models || {}; redrawQuick(); }).catch(() => {});

applyPrefs(); drawHandsFree();
loadModelInfo();
loadTools();
loadGithub();
loadRoutings();
// chat.html#chat=ID (the Dashboard's recent chats) opens that chat
const linked = decodeURIComponent((location.hash.match(/^#chat=(.+)$/) || [])[1] || '');
let lastOpen = null;
try { lastOpen = localStorage.getItem('harness-chat-open'); } catch {}
// chat.html#project=ID (an agent's project link) shows that project's chats
const linkedProject = decodeURIComponent((location.hash.match(/^#project=(.+)$/) || [])[1] || '');
let openProject = false;
if (linkedProject && projects.some(x => x.id === linkedProject)) {
  openProject = true;
  scope = linkedProject;
  store.set('harness-chat-scope', scope);
  history.replaceState(null, '', location.pathname + location.search); // the chat opened below puts its own address back
}
openChat(openProject ? index.find(e => e.project === scope)?.id
  : [linked, lastOpen].find(id => id && index.some(e => e.id === id)) || index[0]?.id);
drawSide();
setTimeout(checkSchedules, 1500);
connectLive();
loadRecent();
sync.start();
// Activity is a drawer now: it stays closed on load instead of covering the chat
setActivity(false);
setSide(narrow() ? false : panelOpen);
setInterval(() => { drawList(); drawSchedules(); }, 60000);
