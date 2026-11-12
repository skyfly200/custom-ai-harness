// Skills the assistant saved on the server (utils/skillStore.js, GET /ui/api/assistant/skills) join the list the
// Skills page and the chat page read from this browser. A server skill is added only when no local skill has its
// id or its name, so an edited local copy wins. The merge is in memory: the server copy stays the source.
// Owner only: for anyone else the fetch fails and the local list is used as it is.
(function (root) {
  'use strict';

  function merge(local, server) {
    const ids = new Set(local.map((s) => s.id));
    const names = new Set(local.map((s) => String(s.name || '').toLowerCase()));
    const extra = (server || []).filter((s) => s && !ids.has(s.id) && !names.has(String(s.name || '').toLowerCase()));
    return extra.length ? [...local, ...extra.map((s) => ({ ...s }))] : local;
  }

  async function load(local, { fetchImpl = root.fetch, base = root.location?.href } = {}) {
    try {
      const res = await fetchImpl(new URL('api/assistant/skills', base).href, { credentials: 'same-origin' });
      if (!res.ok) return local;
      const body = await res.json();
      return merge(local, Array.isArray(body.skills) ? body.skills : []);
    } catch {
      return local;
    }
  }

  const api = { merge, load };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ServerSkills = api;
})(typeof window !== 'undefined' ? window : globalThis);
