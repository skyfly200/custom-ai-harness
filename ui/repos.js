// The repos attached to a chat, a chat project or an agent: an ordered list, and the first one is the
// default to work in. An entry is either a GitHub repo { kind: 'github', full: 'owner/name', branch, private }
// or a git folder on this computer { kind: 'local', path, name, branch, head, remote, ... }.
//
// Older data has one repo: chat.github (GitHub) and chat.repo / project.repo (folder). list() reads those as a
// list, and set() writes the list back and keeps those two fields in step (the first GitHub entry and the first
// folder entry), so a chat saved here still opens in an older page and the code that asks for "the" repo of a
// kind keeps working. Pure functions with no DOM, so the node tests load this file too.
(function (root) {
  const isGithub = (e) => e && e.kind === 'github';
  const isLocal = (e) => e && e.kind === 'local';

  // One entry in its stored form, or null when it names nothing
  function clean(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.kind === 'github' || (!e.kind && e.full)) {
      const full = String(e.full || '').trim();
      return full ? { kind: 'github', full, ...(e.branch ? { branch: e.branch } : {}), ...(e.private != null ? { private: !!e.private } : {}) } : null;
    }
    if (e.kind === 'local' || (!e.kind && e.path)) {
      const path = String(e.path || '').trim();
      if (!path) return null;
      const { kind, ...rest } = e;
      return { kind: 'local', ...rest, path, name: e.name || path.split(/[\\/]/).filter(Boolean).pop() || path };
    }
    return null;
  }

  /** The repos of a chat or project as a list, whatever shape it was saved in. */
  function list(owner) {
    if (!owner) return [];
    if (Array.isArray(owner.repos)) return owner.repos.map(clean).filter(Boolean);
    return [clean(owner.github && { ...owner.github, kind: 'github' }), clean(owner.repo && { ...owner.repo, kind: 'local' })].filter(Boolean);
  }

  /** Save `entries` on a chat or project, and mirror the first of each kind into the old fields. */
  function set(owner, entries) {
    const seen = new Set();
    const out = entries.map(clean).filter((e) => e && !seen.has(keyOf(e)) && seen.add(keyOf(e)));
    owner.repos = out;
    const gh = out.find(isGithub);
    const lo = out.find(isLocal);
    if (gh) owner.github = { full: gh.full, branch: gh.branch, private: gh.private }; else delete owner.github;
    if (lo) { const { kind, ...rest } = lo; owner.repo = rest; } else delete owner.repo;
    if (!out.length) delete owner.repos;
    return out;
  }

  const keyOf = (e) => (isGithub(e) ? `github:${e.full.toLowerCase()}` : `local:${e.path}`);
  const labelOf = (e) => (isGithub(e) ? e.full : e.name || e.path);
  /** What is passed to the runner for a repo: owner/name for GitHub, the folder path for a folder. */
  const specOf = (e) => (isGithub(e) ? e.full : e.path);

  /** A chat's (or agent's) repos: its own if it set any, else those of its project. */
  function effective(owner, project) {
    const own = list(owner);
    return own.length ? own : list(project);
  }

  /** Whether the list is the owner's own, rather than inherited. */
  const isOwn = (owner) => list(owner).length > 0;

  /** The default repo of a kind (or of any kind): the first in the list. */
  const defaultOf = (entries, kind) => entries.find((e) => !kind || e.kind === kind) || null;

  function add(entries, entry) {
    const e = clean(entry);
    if (!e || entries.some((x) => keyOf(x) === keyOf(e))) return entries.slice();
    return [...entries, e];
  }
  const remove = (entries, key) => entries.filter((e) => keyOf(e) !== key);
  function makeDefault(entries, key) {
    const e = entries.find((x) => keyOf(x) === key);
    return e ? [e, ...entries.filter((x) => x !== e)] : entries.slice();
  }
  function move(entries, key, by) {
    const i = entries.findIndex((x) => keyOf(x) === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= entries.length) return entries.slice();
    const out = entries.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  /**
   * Which attached repo a name means: "owner/name", "name", a folder name or path, any case. A name that
   * matches two repos is ambiguous (returns { error }); nothing given returns the default of `kind`.
   */
  function find(entries, name, kind) {
    const pool = entries.filter((e) => !kind || e.kind === kind);
    const q = String(name || '').trim().toLowerCase().replace(/\\/g, '/');
    if (!q) return { repo: pool[0] || null };
    const exact = pool.filter((e) => [e.full, e.path, e.name].some((v) => v && String(v).toLowerCase().replace(/\\/g, '/') === q));
    const part = exact.length ? exact : pool.filter((e) => (isGithub(e) ? e.full.split('/')[1] : e.name || '').toLowerCase() === q);
    if (part.length === 1) return { repo: part[0] };
    if (part.length > 1) return { error: `“${name}” matches ${part.map(labelOf).join(' and ')}; give the full name` };
    return { error: `${name} is not attached${pool.length ? `; the attached ${kind === 'github' ? 'GitHub ' : kind === 'local' ? 'folder ' : ''}repos are ${pool.map(labelOf).join(', ')}` : ''}` };
  }

  /**
   * Two copies of a chat's list after a sync conflict. Folders only exist on this computer, so they come from `mine`;
   * the GitHub repos come from `theirs` when they differ (that copy is the newer, or the other device's).
   */
  function mergeKeepingFolders(mine, theirs) {
    const gh = (l) => l.filter(isGithub).map(keyOf).join();
    if (gh(mine) === gh(theirs)) return mine;
    return [...theirs.filter(isGithub), ...mine.filter(isLocal)];
  }

  /** A list of "owner/name" or path strings (what an agent stores) as entries. */
  function fromSpecs(specs) {
    return (specs || []).map((s) => String(s || '').trim()).filter(Boolean).map((s) => (/^[\w.-]+\/[\w.-]+$/.test(s) && !/^[a-z]:/i.test(s) ? { kind: 'github', full: s } : { kind: 'local', path: s }));
  }
  const toSpecs = (entries) => entries.map(specOf);

  /** The lines the model is told about the attached repos, or '' for none. */
  function promptText(entries, { folders = true } = {}) {
    const usable = entries.filter((e) => folders || isGithub(e));
    if (usable.length < 2) return '';
    const lines = usable.map((e, i) => (isGithub(e)
      ? `- ${e.full}${e.branch ? ` (default branch ${e.branch})` : ''}${e.private ? ', private' : ''}: GitHub, use the github_ tools`
      : `- ${e.name}${e.branch ? ` (branch ${e.branch})` : ''} at ${e.path}: git folder, use the repo_ tools`) + (i === 0 ? ' [DEFAULT]' : ''));
    return `This chat has ${usable.length} repositories attached:\n${lines.join('\n')}\n`
      + `The first one, ${labelOf(usable[0])}, is the default: work in it, and use it for every repo_ and github_ tool call, unless the user asks otherwise. `
      + 'The others are there to read from, and to work in only when the user asks or names them (for example "in repo X, ..."). '
      + 'Every repo_ and github_ tool takes an optional repo argument (owner/name for GitHub, the folder name for a folder); leave it out for the default. '
      + 'When you change something outside the default repo, say which repo you used.';
  }

  /** The page on github.com for owner/name (or '' for anything else). */
  function githubUrl(full) {
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(full || '').trim());
    return m ? `https://github.com/${m[1]}/${m[2]}` : '';
  }

  /** The GitHub repos (from the connection's list) whose owner/name matches `q`, skipping those already attached. */
  function filterGithub(repos, q, attached = []) {
    const have = new Set(attached.filter(isGithub).map((e) => e.full.toLowerCase()));
    const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (repos || []).filter((r) => r && r.full && !have.has(String(r.full).toLowerCase())
      && words.every((w) => String(r.full).toLowerCase().includes(w)));
  }

  /** Small chips for a list: the default marked. `controls` adds the up, down, make-default and remove buttons; `links` links GitHub names to github.com. */
  function chipsHtml(entries, { controls = false, links = false, esc = (s) => String(s) } = {}) {
    if (!entries.length) return '';
    return entries.map((e, i) => {
      const key = esc(keyOf(e));
      const btn = (act, label, title, off) => `<button type="button" class="repo-btn" data-repo-act="${act}" data-repo-key="${key}" title="${esc(title)}" aria-label="${esc(title)}"${off ? ' disabled' : ''}>${label}</button>`;
      const url = links && isGithub(e) ? githubUrl(e.full) : '';
      const name = url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Open ${esc(e.full)} on GitHub">${esc(labelOf(e))}</a>` : esc(labelOf(e));
      return `<li class="repo-chip${i === 0 ? ' default' : ''}" data-repo-key="${key}">`
        + `<span class="repo-kind" title="${isGithub(e) ? 'A GitHub repo' : 'A git folder on this computer'}">${isGithub(e) ? 'GH' : 'dir'}</span>`
        + `<span class="repo-name" title="${esc(specOf(e))}">${name}</span>`
        + (i === 0 ? '<span class="repo-default" title="Work happens here unless you say otherwise">default</span>' : '')
        + (controls
          ? `<span class="repo-ctl">${i === 0 ? '' : btn('default', 'Make default', 'Make this the default repo')}${btn('up', '↑', 'Move up', i === 0)}${btn('down', '↓', 'Move down', i === entries.length - 1)}${btn('remove', '×', `Remove ${labelOf(e)}`)}</span>`
          : '')
        + '</li>';
    }).join('');
  }

  /**
   * Make the buttons inside `box` work on a list. get() returns the current entries, change(next) receives the new ones.
   */
  function bind(box, get, change) {
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-repo-act]');
      if (!b || b.disabled) return;
      const key = b.dataset.repoKey;
      const cur = get();
      const next = b.dataset.repoAct === 'remove' ? remove(cur, key)
        : b.dataset.repoAct === 'default' ? makeDefault(cur, key)
          : move(cur, key, b.dataset.repoAct === 'up' ? -1 : 1);
      change(next);
    });
  }

  const api = { list, set, effective, isOwn, defaultOf, add, remove, makeDefault, move, find, keyOf, labelOf, specOf, fromSpecs, toSpecs, mergeKeepingFolders, promptText, chipsHtml, bind, isGithub, isLocal, githubUrl, filterGithub };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Repos = api;
})(typeof window !== 'undefined' ? window : globalThis);
