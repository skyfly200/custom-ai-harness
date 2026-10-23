// Users and API keys page (HARNESS_REQUIRE_LOGIN). The server decides who may do what; this only hides what you can't use.
(() => {
  const $ = (id) => document.getElementById(id);
  let me = null;

  const say = (text, bad) => { $('msg').textContent = text || ''; $('msg').style.color = bad ? 'var(--bad, #c4264a)' : ''; };
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  }
  const cell = (text) => { const td = document.createElement('td'); td.style.padding = '6px 8px'; td.textContent = text; return td; };
  const btn = (text, fn, hint) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.title = hint || '';
    b.addEventListener('click', async () => { try { await fn(); } catch (e) { say(e.message, true); } });
    return b;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

  function drawUsers(users) {
    const t = $('userTable');
    t.replaceChildren();
    for (const u of users) {
      const tr = document.createElement('tr');
      tr.append(cell(u.name), cell(u.core ? 'admin (env)' : u.role), cell(`${u.keys} key${u.keys === 1 ? '' : 's'}`), cell(when(u.created)));
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px 8px;text-align:right;white-space:nowrap';
      if (!u.core) {
        td.append(
          btn('Reset password', async () => {
            const password = prompt(`New password for ${u.name} (at least ${me.minPassword} characters):`);
            if (!password) return;
            await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}`, { password });
            say(`Password changed for ${u.name}.`);
          }),
          ' ',
        );
        if (u.name.toLowerCase() !== me.name.toLowerCase()) {
          td.append(
            btn(u.role === 'admin' ? 'Make user' : 'Make admin', async () => { drawUsers((await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}`, { role: u.role === 'admin' ? 'user' : 'admin' })).users); }),
            ' ',
            btn('Remove', async () => {
              if (!confirm(`Remove ${u.name} and their API keys?`)) return;
              drawUsers((await api('DELETE', `/ui/api/users/${encodeURIComponent(u.name)}`)).users);
              fillOwners(); loadKeys();
            }),
          );
        }
      }
      tr.append(td);
      t.append(tr);
    }
  }

  const owner = () => (me.role === 'admin' ? $('owner').value || me.name : me.name);
  async function fillOwners() {
    if (me.role !== 'admin') return;
    const { users } = await api('GET', '/ui/api/users');
    const current = $('owner').value || me.name;
    $('owner').replaceChildren(...users.map((u) => new Option(u.name, u.name)));
    $('owner').value = users.some((u) => u.name === current) ? current : me.name;
    drawUsers(users);
  }
  async function loadKeys() {
    const { keys } = await api('GET', `/ui/api/keys?owner=${encodeURIComponent(owner())}`);
    const t = $('keyTable');
    t.replaceChildren();
    if (!keys.length) { const tr = document.createElement('tr'); tr.append(cell('No keys yet.')); t.append(tr); }
    for (const k of keys) {
      const tr = document.createElement('tr');
      tr.append(cell(k.name), cell(`${k.prefix}…`), cell(when(k.created)));
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px 8px;text-align:right';
      td.append(btn('Revoke', async () => {
        if (!confirm(`Revoke the key "${k.name}"? Programs using it stop working.`)) return;
        await api('DELETE', `/ui/api/keys/${k.id}?owner=${encodeURIComponent(owner())}`);
        loadKeys(); fillOwners();
      }));
      tr.append(td);
      t.append(tr);
    }
  }

  $('addUser').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const f = Object.fromEntries(new FormData(e.target));
      drawUsers((await api('POST', '/ui/api/users', f)).users);
      e.target.reset(); say(`Added ${f.name}.`); fillOwners();
    } catch (err) { say(err.message, true); }
  });
  $('addKey').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/ui/api/keys', { owner: owner(), name: new FormData(e.target).get('name') || 'key' });
      $('newKey').hidden = false;
      $('newKey').textContent = `${r.key}\nCopy it now: it is not shown again.`;
      e.target.reset(); loadKeys(); fillOwners(); say('');
    } catch (err) { say(err.message, true); }
  });
  $('owner').addEventListener('change', () => { $('newKey').hidden = true; loadKeys(); });
  $('pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/ui/api/me/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset(); say('Password changed.');
    } catch (err) { say(err.message, true); }
  });

  (async () => {
    try { me = await api('GET', '/ui/api/me'); } catch { $('off').hidden = false; $('keysHead').hidden = true; document.querySelectorAll('.card').forEach((c) => { c.hidden = true; }); return; }
    $('who').textContent = `${me.name} · ${me.role}`;
    $('minpw').textContent = `At least ${me.minPassword} characters.`;
    $('pwSection').hidden = me.core;
    if (me.role === 'admin') { $('admin').hidden = false; $('ownerRow').hidden = false; await fillOwners(); }
    loadKeys();
  })();
})();
