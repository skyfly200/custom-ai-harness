// The Tools page's setup wizard, without the drawing: which programs a catalog
// entry needs, whether its answers are filled in, the entry they make, and a
// plain next step for a failed test. Also used by tests.
(function (root) {
  'use strict';

  const LAUNCHERS = new Set(['npx', 'uvx', 'node', 'uv', 'docker', 'python']);

  // The program a program-type entry starts with, when it is one we can check for
  function requiredPrograms(item) {
    const sp = item.spec || {};
    return !sp.url && sp.command && LAUNCHERS.has(sp.command) ? [sp.command] : [];
  }

  // One row per needed program: { name, found, hint }. `programs` is what the server reported
  function checkPrograms(item, programs) {
    return requiredPrograms(item).map((name) => {
      const p = (programs || {})[name];
      // not in the server's list (docker, python): unknown, so don't block on it
      return { name, found: p ? !!p.found : null, hint: p?.hint || '' };
    });
  }

  const blocked = (checks) => checks.filter((c) => c.found === false);

  const inputsOf = (item) => item.inputs || [];
  const filled = (v) => typeof v === 'string' && v.trim() !== '';
  const missingInputs = (item, values) => inputsOf(item).filter((i) => !filled(values[i.id]));

  // The entry the answers make, in the shape the save and test calls take
  function buildEntry(item, values) {
    const sp = JSON.parse(JSON.stringify(item.spec));
    const rows = (m) => Object.entries(m || {}).map(([key, value]) => ({ key, value }));
    let env = rows(sp.env);
    let headers = rows(sp.headers);
    const put = (list, key, value) => {
      const row = list.find((r) => r.key === key);
      if (row) row.value = value; else list.push({ key, value });
    };
    for (const i of inputsOf(item)) {
      const v = String(values[i.id] ?? '').trim();
      if (!v) continue;
      if (i.into.arg !== undefined) { sp.args = sp.args || []; sp.args[i.into.arg] = v; }
      else if (i.into.env) put(env, i.into.env, v);
      else if (i.into.header) put(headers, i.into.header, (i.into.prefix || '') + v);
    }
    delete sp.env; delete sp.headers;
    if (env.length) sp.env = env;
    if (headers.length) sp.headers = headers;
    return sp;
  }

  // A pasted token: strip a leading "Bearer " and stray spaces or quotes people copy along
  function cleanSecret(text, prefix) {
    let v = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
    if (prefix && v.toLowerCase().startsWith(prefix.trim().toLowerCase() + ' ')) v = v.slice(prefix.length).trim();
    return v;
  }

  // What to try next for a failed test, from the error text. Empty when there is nothing more to say
  function nextStep(error, item) {
    const e = String(error || '');
    const hasKey = inputsOf(item || {}).some((i) => i.kind === 'secret');
    if (/refused the login|HTTP 40[13]/.test(e)) return hasKey ? 'The key was refused. Go back, paste it again (check it is complete and has not expired), then test again.' : 'The service refused the login.';
    if (/not found on PATH/.test(e)) return 'The program is not installed. Install it as the first step says, then test again.';
    if (/does not exist|no such|ENOENT/i.test(e) && inputsOf(item || {}).some((i) => i.kind === 'folder')) return 'Check the folder path in the previous step.';
    if (/did not answer|no answer/.test(e)) return 'The first start downloads the server and can take a minute or two. Test again; if it keeps timing out, run the same command once in a terminal.';
    if (/is not set|are not set/.test(e)) return 'A value it reads from .env is not set. Add it there, restart the Interceptor, and test again.';
    return '';
  }

  const api = { requiredPrograms, checkPrograms, blocked, missingInputs, buildEntry, cleanSecret, nextStep };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ToolSetup = api;
})(typeof window !== 'undefined' ? window : globalThis);
