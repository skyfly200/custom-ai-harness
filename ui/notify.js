// "It's waiting for you" notifications: a command the guard wants you to allow, a
// run that needs a decision, a chat reply that has finished. They use the browser's
// own notifications, so they work in a background tab and in the installed app, and
// only while a harness page is open (nothing is pushed from the server). They say
// what happened, never what was said or run: no command text, no reply text.
// Pure helpers run in Node tests (require); the rest runs in the page (window.Notify).
(function (root) {
  const KEY = 'harness-notify';
  const DEFAULTS = { on: false, approval: true, reply: true };
  const TEXT = {
    approval: { title: 'Needs your approval', body: 'A command is waiting for you to allow or decline it.' },
    run: { title: 'An agent needs you', body: 'A run is waiting for you to allow or decline a step.' },
    reply: { title: 'Reply ready', body: 'The chat is waiting for your next message.' },
  };
  const PREF_OF = { approval: 'approval', run: 'approval', reply: 'reply' };

  const parsePrefs = (raw) => {
    let saved = {};
    try { saved = JSON.parse(raw) || {}; } catch { /* default */ }
    const prefs = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === 'boolean') prefs[k] = saved[k];
    return prefs;
  };

  // Notify only when you are not already looking at the page
  const shouldNotify = (prefs, kind, { hidden, focused, permission }) => {
    if (!TEXT[kind] || !prefs.on || permission !== 'granted') return false;
    if (!prefs[PREF_OF[kind]]) return false;
    return !!hidden || !focused;
  };

  // The run ids that wait on you now and did not last time
  const newWaiting = (seen, runs) => {
    const now = (runs || []).filter((r) => r.status === 'waiting' && r.pending).map((r) => r.id);
    const fresh = now.filter((id) => !seen.has(id));
    seen.clear();
    now.forEach((id) => seen.add(id));
    return fresh;
  };

  const api = { DEFAULTS, TEXT, parsePrefs, shouldNotify, newWaiting };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const load = () => { try { return parsePrefs(localStorage.getItem(KEY)); } catch { return { ...DEFAULTS }; } };
  const save = (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ } };
  const supported = () => typeof Notification !== 'undefined';
  const permission = () => (supported() ? Notification.permission : 'denied');

  async function show(kind, url) {
    const prefs = load();
    if (!shouldNotify(prefs, kind, { hidden: document.hidden, focused: document.hasFocus(), permission: permission() })) return false;
    const { title, body } = TEXT[kind];
    const options = { body, tag: `harness-${kind}`, icon: 'icon-192.png', badge: 'icon-192.png', renotify: true, data: { url: url || location.href } };
    try {
      // the service worker's notification also works on phones and in the installed app
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) { await reg.showNotification(title, options); return true; }
    } catch { /* fall back to the page's own */ }
    try {
      const n = new Notification(title, options);
      n.onclick = () => { window.focus(); if (options.data.url && options.data.url !== location.href) location.href = options.data.url; n.close(); };
      return true;
    } catch { return false; }
  }

  // The switches, drawn into any element (Settings page, chat drawer)
  function mount(el) {
    if (!el) return;
    const draw = () => {
      const p = load();
      const perm = permission();
      const note = !supported() ? 'This browser has no notifications.'
        : perm === 'denied' ? 'Blocked in the browser. Allow notifications for this site in its settings, then turn this on.'
        : p.on ? 'On for this device. They show only while you are on another tab or window.' : 'Off for this device.';
      el.innerHTML = `<label class="check"><input type="checkbox" data-n="on"${p.on && perm === 'granted' ? ' checked' : ''}${supported() ? '' : ' disabled'}> Notify me when something waits for me</label>
        <label class="check"><input type="checkbox" data-n="approval"${p.approval ? ' checked' : ''}> A command or run needs my approval</label>
        <label class="check"><input type="checkbox" data-n="reply"${p.reply ? ' checked' : ''}> A reply has finished</label>
        <div class="muted small">${note} <button type="button" class="mini" data-n="test">Send a test</button></div>`;
    };
    el.addEventListener('change', async (e) => {
      const k = e.target.dataset?.n;
      if (!k) return;
      const p = load();
      if (k === 'on' && e.target.checked && permission() !== 'granted') {
        const r = await Notification.requestPermission().catch(() => 'denied');
        p.on = r === 'granted';
      } else p[k] = e.target.checked;
      save(p);
      draw();
    });
    el.addEventListener('click', async (e) => {
      if (e.target.dataset?.n !== 'test') return;
      if (permission() !== 'granted') return ui.toast('Turn notifications on first.');
      const { title, body } = TEXT.reply;
      const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
      const o = { body: `Test: ${body}`, icon: 'icon-192.png', tag: 'harness-test' };
      if (reg?.showNotification) reg.showNotification(title, o); else new Notification(title, o);
    });
    draw();
  }

  const seenRuns = new Set();
  let first = true;
  // Called with each fresh list of runs; the first list only records what already waits
  function watchRuns(runs) {
    const fresh = newWaiting(seenRuns, runs);
    if (first) { first = false; return; }
    if (fresh.length) show('run', 'agents');
  }

  root.Notify = { ...api, show, mount, watchRuns, load };
  document.querySelectorAll('[data-notify-settings]').forEach(mount);
})(typeof window !== 'undefined' ? window : globalThis);
