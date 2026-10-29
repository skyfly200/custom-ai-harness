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
  // the second password box must match the first; says so inline (no alert)
  const mismatch = (f) => (f.password !== f.confirm ? 'The two passwords do not match.' : '');
  // shows the mismatch under the Confirm box of `form` ('' clears it); returns true if it is showing
  function confirmError(form, text) {
    const input = form.elements.confirm;
    let small = input.parentElement.querySelector('.fieldErr');
    if (!small) {
      small = document.createElement('small'); small.className = 'fieldErr'; small.setAttribute('role', 'alert');
      small.style.cssText = 'position:static;width:auto;max-width:none;padding:0;border:0;background:none;box-shadow:none;color:var(--bad, #c4264a)'; // in the flow, not calm.css's hover bubble
      input.parentElement.append(small);
    }
    small.textContent = text; small.style.display = text ? 'block' : 'none'; input.setAttribute('aria-invalid', text ? 'true' : 'false');
    if (text && document.activeElement !== input) input.focus();
    return Boolean(text);
  }
  // typing in either password box clears the message
  document.addEventListener('input', (e) => { if (e.target.form && e.target.form.elements.confirm && /^(password|confirm)$/.test(e.target.name)) confirmError(e.target.form, ''); });
  const cell = (text) => { const td = document.createElement('td'); td.style.padding = '6px 8px'; td.textContent = text; return td; };
  const btn = (text, fn, hint) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.title = hint || '';
    b.addEventListener('click', async () => { try { await fn(); } catch (e) { say(e.message, true); } });
    return b;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

  // inline row under the user: new password + confirm
  function resetForm(name, after) {
    const open = after.nextElementSibling;
    if (open && open.className === 'resetRow') { open.remove(); return; }
    const row = document.createElement('tr'); row.className = 'resetRow';
    const td = document.createElement('td'); td.colSpan = 6; td.style.padding = '6px 8px';
    const form = document.createElement('form'); form.className = 'form'; form.autocomplete = 'off';
    form.innerHTML = `<label class="field"><span>New password</span><input name="password" type="password" required autocomplete="new-password"></label>
      <label class="field"><span>Confirm password</span><input name="confirm" type="password" required autocomplete="new-password"></label>
      <div class="field"><span>&nbsp;</span><span><button class="primary">Set password</button> <button type="button" class="cancel">Cancel</button></span></div>
`;
    form.querySelector('span').textContent = `New password for ${name}`;
    form.querySelector('.cancel').addEventListener('click', () => row.remove());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      if (confirmError(form, mismatch(f))) return;
      try { await api('POST', `/ui/api/users/${encodeURIComponent(name)}`, f); row.remove(); say(`Password changed for ${name}.`); } catch (x) { confirmError(form, x.message); }
    });
    td.append(form); row.append(td); after.after(row);
    form.password.focus();
  }

  // each person's last 30 days of requests, from the admin usage view (loaded by fillOwners)
  let usage30 = {};
  const usageCell = (name) => {
    const td = document.createElement('td');
    td.style.padding = '6px 8px';
    const u = usage30[name.toLowerCase()];
    const a = document.createElement('a');
    a.href = `usage-users.html#user=${encodeURIComponent(name)}`;
    a.textContent = u && u.requests ? `${u.requests.toLocaleString()} request${u.requests === 1 ? '' : 's'} · ${shortCount(u.input + u.output)} tokens` : 'no requests';
    a.title = 'Usage in the last 30 days. Open the details';
    a.style.color = u && u.requests ? 'var(--accent)' : 'var(--muted)';
    td.append(a);
    return td;
  };
  const shortCount = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

  function drawUsers(users) {
    const t = $('userTable');
    t.replaceChildren();
    for (const u of users) {
      const tr = document.createElement('tr');
      const credit = u.credit ? ` · $${u.credit.spentUsd.toFixed(2)} of $${u.credit.capUsd.toFixed(2)} used` : '';
      tr.append(cell(u.name), cell(u.core ? 'admin (env)' : u.guest ? `guest${credit}` : u.role), cell(`${u.keys} key${u.keys === 1 ? '' : 's'}`), cell(when(u.created)), usageCell(u.name));
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px 8px;text-align:right;white-space:nowrap';
      if (!u.core) {
        td.append(
          btn('Reset password', () => resetForm(u.name, tr)),
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
    try { usage30 = Object.fromEntries((await api('GET', '/ui/api/admin/usage?days=30')).users.map((p) => [p.user.toLowerCase(), p])); } catch { usage30 = {}; }
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
      if (confirmError(e.target, mismatch(f))) return;
      drawUsers((await api('POST', '/ui/api/users', f)).users);
      e.target.reset(); confirmError(e.target, ''); say(`Added ${f.name}.`); fillOwners();
    } catch (err) { say(err.message, true); }
  });
  // The OpenRouter connection: a status line here, the details in a dialog (same shape as ui/githubconnect.js).
  let cred = null;
  const money = (n) => `$${n.toFixed(2)}`;
  const KIND = { oauth: 'connected with OpenRouter', managed: 'key issued by this server, replaced when it lapses', key: 'pasted key' };
  function credState(c) {
    if (!c || !c.set) return { dot: 'bad', head: 'Not connected', sub: 'Requests are refused until you connect your OpenRouter account.', btn: 'Connect' };
    const h = c.health || {};
    const left = typeof h.limitRemaining === 'number' ? `${money(Math.max(0, h.limitRemaining))} left on the key` : '';
    const ending = `key …${c.last4 || '????'}`;
    const day = h.expiresAt ? new Date(h.expiresAt).toLocaleDateString() : 'soon';
    if (h.state === 'invalid') return { dot: 'bad', head: 'OpenRouter no longer accepts this key', sub: 'Reconnect to make a new one.', btn: 'Reconnect', problem: true };
    if (h.state === 'expired') return { dot: 'bad', head: 'This key has expired', sub: 'Reconnect to make a new one.', btn: 'Reconnect', problem: true };
    if (h.state === 'exhausted') return { dot: 'bad', head: 'This key has used up its limit', sub: 'Raise it at openrouter.ai/settings/keys, or reconnect for a fresh key.', btn: 'Manage', problem: true };
    if (h.state === 'expiring') return { dot: 'warn', head: `Connected, key expires ${day}`, sub: [ending, left].filter(Boolean).join(' · '), btn: 'Manage' };
    return { dot: 'ok', head: 'Connected to OpenRouter', sub: [KIND[c.kind], ending, left].filter(Boolean).join(' · '), btn: 'Manage' };
  }
  function drawCredentialLine() {
    const s = credState(cred);
    $('orDot').className = `orDot ${s.dot}`;
    $('orHead').textContent = s.head;
    $('orSub').textContent = s.sub;
    $('orOpen').textContent = s.btn;
    $('orOpen').disabled = false;
  }
  async function drawCredential() {
    const c = await api('GET', '/ui/api/me/credential');
    $('keySection').hidden = !(c.required || (c.credential && c.credential.set));
    cred = c.credential || { set: false };
    drawCredentialLine();
    const s = credState(cred);
    if (s.problem) ui.toast(`${s.head}. ${s.sub}`, { kind: 'error' });
    $('guestSection').hidden = !c.guest;
    if (c.guest) $('guestState').textContent = c.credit ? `You are a guest. $${c.credit.leftUsd.toFixed(2)} left of $${c.credit.capUsd.toFixed(2)}, in all (not monthly). Only models with a known price are available.` : 'You are a guest.';
  }
  function openCredentialDialog() {
    const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    return ui.dialog((box, close) => {
      box.append(el('h3', { textContent: 'OpenRouter' }));
      const status = el('p', { style: 'margin-bottom:8px' });
      const why = el('p', { className: 'muted', textContent: 'Your chats and API calls are billed to your own OpenRouter account, not to the owner of this server. OpenRouter makes a key for this server; it is kept encrypted and never shown again. You can revoke it any time at openrouter.ai/settings/keys.' });
      const form = el('form', { autocomplete: 'off', style: 'margin:0' });
      const input = el('input', { type: 'password', placeholder: 'sk-or-…', autocomplete: 'off', spellcheck: false });
      input.setAttribute('aria-label', 'OpenRouter key');
      form.append(input, el('button', { type: 'submit', className: 'primary', textContent: 'Use this key' }));
      const paste = el('details', { style: 'margin-bottom:12px' }, el('summary', { className: 'muted', textContent: 'Paste a key instead' }), el('p', { className: 'muted', textContent: 'Make one at openrouter.ai/keys and paste it here.' }), form);
      const actions = el('div', { className: 'ui-actions' });
      const closeBtn = el('button', { type: 'button', textContent: 'Close' });
      closeBtn.addEventListener('click', () => close(null));
      box.append(status, why, paste, actions);

      const go = el('button', { type: 'button', className: 'primary' });
      go.addEventListener('click', () => { go.disabled = true; go.textContent = 'Opening OpenRouter…'; location.href = '/ui/api/me/credential/connect'; });
      const off = el('button', { type: 'button', textContent: 'Disconnect' });
      off.addEventListener('click', async () => {
        if (!await ui.confirm('Disconnect OpenRouter? Your requests are refused until you connect again.', { ok: 'Disconnect', danger: true })) return;
        off.disabled = true;
        try { await api('DELETE', '/ui/api/me/credential'); ui.toast('Disconnected. Revoke the key at openrouter.ai/settings/keys too if you want it dead.', { kind: 'ok' }); await drawCredential(); draw(); } catch (err) { off.disabled = false; ui.toast(err.message, { kind: 'error' }); }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return input.focus();
        const submit = form.querySelector('button'); submit.disabled = true;
        try { await api('PUT', '/ui/api/me/credential', { key: input.value.trim() }); input.value = ''; paste.open = false; ui.toast('Key saved.', { kind: 'ok' }); await drawCredential(); draw(); } catch (err) { ui.toast(err.message, { kind: 'error' }); } finally { submit.disabled = false; }
      });
      function draw() {
        const s = credState(cred);
        status.replaceChildren(el('span', { className: `orDot ${s.dot}`, style: 'display:inline-block;margin-right:8px' }), el('strong', { textContent: s.head }), el('br'), el('span', { className: 'muted', textContent: s.sub }));
        go.disabled = false;
        go.textContent = cred && cred.set ? 'Reconnect with OpenRouter' : 'Connect with OpenRouter';
        input.placeholder = cred && cred.set ? 'Paste a new key to replace it' : 'sk-or-…';
        actions.replaceChildren(...(cred && cred.set ? [off] : []), closeBtn, go);
      }
      draw();
      return go;
    });
  }
  $('orOpen').addEventListener('click', openCredentialDialog);
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
      const f = Object.fromEntries(new FormData(e.target));
      if (confirmError(e.target, mismatch(f))) return;
      await api('POST', '/ui/api/me/password', f);
      e.target.reset(); confirmError(e.target, ''); say('Password changed.');
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
    if (back) { ui.toast(back === 'connected' ? 'OpenRouter connected.' : `OpenRouter was not connected: ${back === 'unavailable' ? 'this account cannot use its own key' : back}`, { kind: back === 'connected' ? 'ok' : 'error' }); history.replaceState(null, '', location.pathname); }
  })();
})();
