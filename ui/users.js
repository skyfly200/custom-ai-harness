// Users and API keys page (HARNESS_REQUIRE_LOGIN). The server decides who may do what; this only hides what you can't use.
(() => {
  const $ = (id) => document.getElementById(id);
  let me = null;
  let managedOn = false; // the server holds a Management API key
  let guestsOn = false; // guest accounts need the database

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
      const credit = u.credit ? ` · $${u.credit.spentUsd.toFixed(2)} of $${u.credit.capUsd.toFixed(2)} used` : '';
      tr.append(cell(u.name), cell(u.core ? 'admin (env)' : u.guest ? `guest${credit}` : u.role), cell(`${u.keys} key${u.keys === 1 ? '' : 's'}`), cell(when(u.created)));
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px 8px;text-align:right;white-space:nowrap';
      if (!u.core) {
        td.append(
          btn('Reset password', async () => {
            const password = await ui.prompt(`New password for ${u.name} (at least ${me.minPassword} characters):`, { type: 'password', ok: 'Change' });
            if (!password) return;
            await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}`, { password });
            say(`Password changed for ${u.name}.`);
          }),
          ' ',
        );
        if (managedOn && !u.guest && u.role !== 'admin') {
          td.append(btn('Issue key', async () => {
            await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}/managed-key`);
            say(`${u.name} has a new key (billed to your OpenRouter account, up to its limit).`);
          }, 'Creates an OpenRouter key for them, billed to your account up to its limit, and replaces any key they have'), ' ');
        }
        if (guestsOn && u.role !== 'admin') {
          td.append(
            btn(u.guest ? 'Make full user' : 'Make guest', async () => { drawUsers((await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}`, { guest: !u.guest })).users); }),
            ' ',
          );
          if (u.guest) {
            td.append(btn('Set cap', async () => {
              const v = await ui.prompt(`Total dollars ${u.name} may spend (now $${u.credit ? u.credit.capUsd.toFixed(2) : '?'}):`, { ok: 'Set cap' });
              if (v === null || v === '') return;
              drawUsers((await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}`, { capUsd: v })).users);
            }), ' ');
          }
        }
        if (u.name.toLowerCase() !== me.name.toLowerCase()) {
          td.append(
            btn(u.role === 'admin' ? 'Make user' : 'Make admin', async () => { drawUsers((await api('POST', `/ui/api/users/${encodeURIComponent(u.name)}`, { role: u.role === 'admin' ? 'user' : 'admin' })).users); }),
            ' ',
            btn('Remove', async () => {
              if (!await ui.confirm(`Remove ${u.name} and their API keys?`)) return;
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

  function drawInvites({ invites, providers }) {
    $('inviteSection').hidden = false;
    if (providers && !providers.length) $('inviteNote').textContent = 'Google and GitHub sign-in is off (set NEON_AUTH_BASE_URL in .env). Invites are kept for when it is on.';
    const t = $('inviteTable');
    t.replaceChildren();
    if (!invites.length) { const tr = document.createElement('tr'); tr.append(cell('Nobody invited yet.')); t.append(tr); }
    for (const i of invites) {
      const tr = document.createElement('tr');
      tr.append(cell(i.email), cell(i.role), cell(when(i.added)));
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px 8px;text-align:right';
      td.append(btn('Remove', async () => {
        if (!await ui.confirm(`Remove the invite for ${i.email}? Existing sessions keep working until they end.`)) return;
        drawInvites(await api('DELETE', `/ui/api/invites/${encodeURIComponent(i.email)}`));
      }));
      tr.append(td);
      t.append(tr);
    }
  }

  const owner = () => (me.role === 'admin' ? $('owner').value || me.name : me.name);
  async function fillOwners() {
    if (me.role !== 'admin') return;
    const { users, guests, managedKeys } = await api('GET', '/ui/api/users');
    guestsOn = Boolean(guests);
    managedOn = Boolean(managedKeys);
    $('guestRow').hidden = !guestsOn;
    document.querySelectorAll('.guestOpt').forEach((o) => { o.hidden = !guestsOn; });
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
        if (!await ui.confirm(`Revoke the key "${k.name}"? Programs using it stop working.`)) return;
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
  async function drawCredential() {
    const c = await api('GET', '/ui/api/me/credential');
    $('keySection').hidden = !(c.required || (c.credential && c.credential.set));
    if (c.credential) $('keyState').textContent = !c.credential.set ? 'Not connected yet: you cannot use models until you connect OpenRouter.'
      : `${c.credential.kind === 'oauth' ? 'Connected through OpenRouter' : c.credential.kind === 'managed' ? 'A key issued for you by the server (replaced automatically when it lapses)' : 'A pasted key'} (key ending …${c.credential.last4 || '????'}).`;
    const h = c.credential && c.credential.set && c.credential.health;
    const WHY = {
      invalid: 'OpenRouter no longer accepts this key. Press Reconnect OpenRouter.',
      expired: 'This key has expired. Press Reconnect OpenRouter.',
      expiring: `This key expires ${h && h.expiresAt ? new Date(h.expiresAt).toLocaleDateString() : 'soon'}. Press Reconnect OpenRouter before then.`,
      exhausted: 'This key has used up its OpenRouter limit. Raise the limit at openrouter.ai/settings/keys, or press Reconnect OpenRouter for a fresh key.',
    };
    if (h && WHY[h.state]) { $('keyState').textContent += ' ' + WHY[h.state]; say(WHY[h.state], true); }
    $('guestSection').hidden = !c.guest;
    if (c.guest) $('guestState').textContent = c.credit ? `You are a guest. $${c.credit.leftUsd.toFixed(2)} left of $${c.credit.capUsd.toFixed(2)}, in all (not monthly). Only models with a known price are available.` : 'You are a guest.';
  }
  $('setKey').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', '/ui/api/me/credential', { key: new FormData(e.target).get('key') }); e.target.reset(); say('Key saved.'); drawCredential(); } catch (err) { say(err.message, true); }
  });
  $('connectOr').addEventListener('click', () => { location.href = '/ui/api/me/credential/connect'; });
  $('clearKey').addEventListener('click', async () => {
    try { await api('DELETE', '/ui/api/me/credential'); say('Disconnected. Revoke the key at openrouter.ai/settings/keys too if you want it dead.'); drawCredential(); } catch (err) { say(err.message, true); }
  });
  $('addInvite').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const f = Object.fromEntries(new FormData(e.target));
      drawInvites(await api('POST', '/ui/api/invites', f));
      e.target.reset(); say(`Invited ${f.email}.`);
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
    if (me.role === 'admin') { $('admin').hidden = false; $('ownerRow').hidden = false; await fillOwners(); drawInvites(await api('GET', '/ui/api/invites')); }
    loadKeys();
    drawCredential().catch(() => {});
    const back = new URLSearchParams(location.search).get('openrouter');
    if (back) { say(back === 'connected' ? 'OpenRouter connected.' : `OpenRouter was not connected: ${back === 'unavailable' ? 'this account cannot use its own key' : back}`, back !== 'connected'); history.replaceState(null, '', location.pathname); }
  })();
})();
