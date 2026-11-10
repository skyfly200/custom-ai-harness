'use strict';
// The sleep countdown card: a ring that runs down to the moment the hosted server sleeps, what a running job
// does to it (it keeps the server awake and the clock starts again when the job ends), and Stop now / Extend on
// hover. The Dashboard shows it inline (a #sleepSlot element); every other page gets it floating in the corner.
// Shown only where the server can stop itself (the Fly launcher). Pure helpers run in Node tests (require);
// the rest runs in the page (window.SleepCard).
(function (root) {
  // where this script lives: the stylesheet sits next to it, so a page needs only this script tag
  const SELF = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  const RING = 2 * Math.PI * 26; // circumference of the ring (r = 26 in a 64 box)
  const MIN = 60 * 1000;

  // "42 min", "1 h 05 min", "under a minute"
  function fmt(ms) {
    const total = Math.max(0, Math.round(ms / MIN));
    if (ms > 0 && ms < MIN) return 'under a minute';
    if (total < 60) return `${total} min`;
    const h = Math.floor(total / 60), m = total % 60;
    return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
  }

  // The ring's state from /ui/api/server, with `elapsedMs` since that answer arrived.
  // kind: 'stopping' | 'busy' (a job keeps it awake) | 'counting' (runs down to sleep) | 'on' (stays on)
  function view(st, elapsedMs = 0) {
    if (!st || !st.canStop) return null;
    if (st.stopping) return { kind: 'stopping', frac: 0, short: 'Stop…', note: 'Stopping', canExtend: false };
    if (st.busy) return { kind: 'busy', frac: 1, short: 'Busy', note: 'A job is running, so the server stays awake. The clock starts again when it finishes.', canExtend: false };
    if (st.stopsInMs === null || st.stopsInMs === undefined) return { kind: 'on', frac: 1, short: 'On', note: 'Stays on until you stop it.', canExtend: false };
    const total = Math.max(1, st.totalMs || st.stopsInMs);
    const left = Math.max(0, st.stopsInMs - elapsedMs);
    const extra = st.extraMs ? ` (+${fmt(st.extraMs)} added)` : '';
    return {
      kind: 'counting',
      frac: Math.min(1, left / total),
      ms: left,
      short: left < MIN ? '<1m' : (left < 60 * MIN ? `${Math.ceil(left / MIN)}m` : `${Math.floor(left / (60 * MIN))}h`),
      note: `Sleeps in ${fmt(left)}${extra}.`,
      canExtend: Boolean(st.canExtend) && (st.maxExtraMs || 0) > (st.extraMs || 0),
    };
  }

  // stroke-dashoffset for a ring showing `frac` of its circle
  const dashOffset = (frac) => RING * (1 - Math.max(0, Math.min(1, frac)));

  const api = { RING, fmt, view, dashOffset };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  // ---- in the page ----------------------------------------------------------
  const TICK_MS = 1000;
  const REFRESH_MS = 10 * 1000;
  const EXTEND_MIN = 30;
  let st = null, fetchedAt = 0, root_ = null, timer = null, busyAct = false;

  const ringSvg = () => `<svg class="sc-ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="sc-track" cx="32" cy="32" r="26"/><circle class="sc-arc" cx="32" cy="32" r="26"
      stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="${RING.toFixed(2)}" transform="rotate(-90 32 32)"/></svg>`;

  function build() {
    const inline = document.getElementById('sleepSlot');
    const el = document.createElement('div');
    el.className = inline ? 'sleep-card' : 'sleep-card sleep-float';
    el.hidden = true;
    el.innerHTML = `<button type="button" class="sc-face" aria-haspopup="true" aria-expanded="false"
        aria-label="Server sleep countdown">${ringSvg()}<span class="sc-short">–</span></button>
      <div class="sc-body">
        <div class="sc-title"><b>Server</b> <span class="sc-dot" aria-hidden="true"></span> <span class="sc-state"></span></div>
        <div class="sc-note sub"></div>
        <div class="sc-actions">
          <button type="button" data-act="extend">Extend ${EXTEND_MIN} min</button>
          <button type="button" data-act="stop" class="sc-stop">Stop now</button>
        </div>
      </div>`;
    if (inline) inline.replaceWith(el); else document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) { act(b.dataset.act); return; }
      // on a phone there is no hover: a tap on the ring opens the panel
      if (e.target.closest('.sc-face') && !inline) { el.classList.toggle('open'); el.querySelector('.sc-face').setAttribute('aria-expanded', String(el.classList.contains('open'))); }
    });
    root_ = el;
    return el;
  }

  function paint() {
    if (!root_) return;
    const v = view(st, Date.now() - fetchedAt);
    root_.hidden = !v;
    if (!v) return;
    root_.dataset.kind = v.kind;
    root_.dataset.warn = String(v.kind === 'counting' && v.ms < 5 * MIN);
    root_.querySelector('.sc-arc').style.strokeDashoffset = dashOffset(v.frac).toFixed(2);
    root_.querySelector('.sc-short').textContent = v.short;
    root_.querySelector('.sc-state').textContent = v.kind === 'counting' ? 'Sleep countdown' : v.kind === 'busy' ? 'Kept awake' : v.kind === 'stopping' ? 'Stopping' : 'Always on';
    root_.querySelector('.sc-note').textContent = v.note;
    const ext = root_.querySelector('[data-act=extend]');
    ext.disabled = !v.canExtend || busyAct;
    root_.querySelector('[data-act=stop]').disabled = v.kind === 'stopping' || busyAct;
  }

  async function refresh() {
    try {
      const res = await fetch('api/server', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      st = await res.json();
      fetchedAt = Date.now();
    } catch { st = null; }
    paint();
  }

  async function post(path, body) {
    const res = await fetch(`api/server/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  async function act(which) {
    if (busyAct) return;
    const ui = window.ui;
    try {
      if (which === 'extend') {
        busyAct = true; paint();
        // the answer comes back while this request is still counted as use, so ask again for the clock
        await post('extend', { minutes: EXTEND_MIN });
        busyAct = false;
        await refresh();
        ui?.toast?.(`Added ${EXTEND_MIN} minutes before it sleeps.`);
      } else if (which === 'stop') {
        const ok = ui?.confirm ? await ui.confirm('Stop the server now? It starts again when you open its address (this takes about a minute), and replies in progress are cut off.') : true;
        if (!ok) return;
        busyAct = true; paint();
        await post('stop');
        st = { ...(st || {}), stopping: true }; fetchedAt = Date.now();
      }
    } catch (err) {
      ui?.toast?.(`Could not ${which === 'extend' ? 'extend' : 'stop'} the server: ${err.message}`, { kind: 'error' });
    } finally { busyAct = false; paint(); }
  }

  function styles() {
    if (!SELF || document.querySelector('link[data-sleepcard]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('sleepcard.css', SELF).href; link.dataset.sleepcard = '1';
    document.head.appendChild(link);
  }

  function start() {
    if (root_ || !document.body) return;
    styles();
    build();
    refresh();
    setInterval(refresh, REFRESH_MS);
    timer = setInterval(paint, TICK_MS);
    // a tap outside the floating card closes its panel
    document.addEventListener('click', (e) => {
      if (root_ && root_.classList.contains('sleep-float') && !root_.contains(e.target)) root_.classList.remove('open');
    });
  }

  root.SleepCard = { start, refresh, view: () => view(st, Date.now() - fetchedAt) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
