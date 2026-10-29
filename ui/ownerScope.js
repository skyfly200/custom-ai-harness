// Whose data is in this browser's localStorage. Chats, projects, skills and schedules are kept there as a
// working copy, and a browser profile is shared by everyone who signs in on it. The page remembers which
// account the copy belongs to; when a different one signs in, the copy is removed instead of being shown
// to them (and uploaded to their account).
// The same code in the page (window.OwnerScope) and in tests (require).
(function (root) {
  const OWNER_KEY = 'harness-owner';
  // Everything person-specific the chat page keeps; settings of the browser itself (theme, notifications) stay
  const PERSONAL = [/^harness-chats$/, /^harness-chat:/, /^harness-projects$/, /^harness-skills$/, /^harness-commands$/,
    /^harness-schedules$/, /^harness-chat-prefs$/, /^harness-sync-ts:/, /^harness-chat-scope$/, /^harness-new-chat-route$/, /^harness-chat-draft/];

  const isPersonal = (key) => PERSONAL.some((re) => re.test(key));

  // stored: the owner this browser's copy was made for (null: never recorded); owner: who is signed in now.
  // hasData: whether the copy holds anything; accountHasData: whether the signed-in account already has chats/data.
  // 'adopt' claims an unlabelled copy: only when it is empty or the account already has its own data,
  // since an unlabelled copy in front of a brand-new account may well be someone else's.
  function decide({ stored, owner, hasData, accountHasData }) {
    if (!owner) return 'keep';
    if (stored === owner) return 'keep';
    if (stored) return 'wipe';
    if (!hasData || accountHasData) return 'adopt';
    return 'wipe';
  }

  // Page side: ask who is signed in, and clear another person's copy before the chat page shows it. Only when the
  // server keeps the copy (a database): without one this browser holds the only copy and is left alone.
  async function guard() {
    if (typeof window === 'undefined') return;
    api.ok = true;
    let owner;
    try {
      const r = await fetch('api/me', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      owner = (await r.json()).name;
    } catch { return; }
    if (!owner) return;
    try {
      const stored = localStorage.getItem(OWNER_KEY);
      if (stored === owner) return;
      const sync = await fetch('api/sync', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!sync) { api.ok = false; return; } // can't tell yet: the page does not sync this time
      if (!sync.db) return;
      const keys = Object.keys(localStorage).filter(isPersonal);
      const accountHasData = (sync.chats || []).length > 0 || Object.keys(sync.data || {}).length > 0;
      const verdict = decide({ stored, owner, hasData: keys.length > 0, accountHasData });
      if (verdict === 'wipe') {
        for (const k of keys) localStorage.removeItem(k);
        try { sessionStorage.removeItem('harness-sync-reloaded'); } catch {}
      }
      localStorage.setItem(OWNER_KEY, owner);
      if (verdict === 'wipe') { api.reloading = true; location.reload(); }
    } catch { /* storage blocked: nothing to protect */ }
  }

  const api = { OWNER_KEY, isPersonal, decide, guard };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.OwnerScope = api; api.ready = api.guard(); } // the chat page waits on `ready` before it syncs
})(typeof window !== 'undefined' ? window : globalThis);
