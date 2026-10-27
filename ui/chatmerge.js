// Joining two copies of one chat: the page's (local) and the server's (remote), after the server
// refused a save because another device or the server added messages in the meantime.
// The same code in the page (window.ChatMerge) and in tests (require).
(function (root) {
  const hasId = (m) => m && typeof m.id === 'string';

  // Messages from both, once each by id. A message both have keeps this page's copy (the page may be
  // writing into that very object); order is by `time`, and messages without one keep their places.
  function mergeMessages(local = [], remote = []) {
    const byId = new Map();
    const order = [];
    const take = (list, from) => {
      list.forEach((m, i) => {
        if (!hasId(m)) return;
        if (!byId.has(m.id)) { byId.set(m.id, { m, from, i }); order.push(m.id); return; }
        // a copy both sides have: this page's (taken last) stands, unless it is still streaming and the other is finished
        const have = byId.get(m.id).m;
        if (from === 'local' && !(m.streaming && !have.streaming)) byId.set(m.id, { m, from, i: byId.get(m.id).i });
      });
    };
    take(remote, 'remote');
    take(local, 'local');
    const all = order.map((id) => byId.get(id).m);
    // every message the page makes carries a time, and then time is the order
    if (all.every((x) => Number.isFinite(x.time))) {
      const rank = new Map(order.map((id, i) => [id, i]));
      return all.slice().sort((x, y) => x.time - y.time || rank.get(x.id) - rank.get(y.id));
    }
    // otherwise: the server's order, with messages only here put after the one that came before them here
    const out = remote.filter(hasId).map((x) => byId.get(x.id).m);
    const placed = new Set(out.map((x) => x.id));
    let prev = null;
    for (const x of local) {
      if (!hasId(x)) continue;
      if (!placed.has(x.id)) {
        const at = prev ? out.findIndex((y) => y.id === prev) + 1 : 0;
        out.splice(at, 0, byId.get(x.id).m);
        placed.add(x.id);
      }
      prev = x.id;
    }
    return out;
  }

  // The chat with both sides' messages; everything else (title, settings) from the side saved last.
  function mergeChats(local, remote) {
    const newer = (local.updated || 0) >= (remote.updated || 0) ? local : remote;
    return { ...newer, messages: mergeMessages(local.messages, remote.messages), updated: Math.max(local.updated || 0, remote.updated || 0) };
  }

  // A cheap fingerprint of a message, to tell which ones changed since the last save
  function fingerprint(m) {
    const s = JSON.stringify(m);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `${s.length}:${h}`;
  }

  // What to send: the messages whose fingerprint differs from `known` (a Map id -> fingerprint), and the order of all
  function delta(messages, known) {
    const upserts = [];
    const seen = new Map();
    for (const m of messages) {
      if (!hasId(m)) continue;
      const f = fingerprint(m);
      seen.set(m.id, f);
      if (known.get(m.id) !== f) upserts.push(m);
    }
    return { upserts, order: [...seen.keys()], fingerprints: seen };
  }

  const api = { mergeMessages, mergeChats, fingerprint, delta };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
