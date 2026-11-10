// The admin Usage page's "Sandboxes and machines" section: E2B and Fly Sprite sandboxes the task runner opened, and Fly
// Machines of this app, from /ui/api/admin/infra-usage (the runner's ledger priced with its rates). Plain SVG, no libraries.
// Runs only when the page has the #infra section.

(() => {
  const $ = (id) => document.getElementById(id);
  if (!$('infra')) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SVG = 'http://www.w3.org/2000/svg';
  const usd = (n) => (window.Costs ? Costs.usd(n) : `$${Number(n || 0).toFixed(2)}`);
  const hours = (s) => (s / 3600).toFixed(s >= 36000 ? 0 : 1);
  const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)'];
  const KIND = { e2b: 'E2B sandbox', sprites: 'Fly Sprite', 'fly-machine': 'Fly Machine' };
  const kindName = (d) => KIND[d] || d;
  const state = { days: 30 };
  try { state.days = JSON.parse(localStorage.getItem('infra-usage-view') || '{}').days ?? 30; } catch { /* keep the default */ }
  const saveView = () => { try { localStorage.setItem('infra-usage-view', JSON.stringify({ days: state.days })); } catch { /* private window */ } };

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function drawChart(report) {
    const svg = $('infraChart');
    svg.textContent = '';
    const days = report.byDay || [];
    const kinds = (report.drivers || []).map((d) => d.driver);
    $('infraLegend').innerHTML = kinds.map((k, i) => `<span><i class="sw" style="background:${COLORS[i % COLORS.length]}"></i>${esc(kindName(k))}</span>`).join('') || '<span class="muted">Nothing in this range</span>';
    if (!days.length) return;
    const W = 720; const H = 220; const pad = { l: 56, r: 12, t: 12, b: 28 };
    const max = Math.max(...days.map((d) => d.cost), 1e-9);
    const slot = (W - pad.l - pad.r) / days.length;
    const bw = Math.max(4, Math.min(40, slot * 0.7));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    for (let g = 0; g <= 4; g++) {
      const y = pad.t + (H - pad.t - pad.b) * (1 - g / 4);
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'var(--line, #8884)' }, svg);
      const t = el('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end', class: 'muted' }, svg);
      t.textContent = usd(max * g / 4);
    }
    days.forEach((d, i) => {
      const x = pad.l + i * slot + (slot - bw) / 2;
      let base = H - pad.b;
      kinds.forEach((k, ki) => {
        const v = d.byDriver[k] || 0;
        if (!v) return;
        const h = (H - pad.t - pad.b) * (v / max);
        const r = el('rect', { x, y: base - h, width: bw, height: Math.max(h, 0.5), fill: COLORS[ki % COLORS.length] }, svg);
        const title = el('title', {}, r);
        title.textContent = `${d.day} · ${kindName(k)}: ${usd(v)}`;
        base -= h;
      });
      if (days.length <= 14 || i % Math.ceil(days.length / 10) === 0) {
        const t = el('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'muted' }, svg);
        t.textContent = d.day.slice(5);
      }
    });
  }

  function drawTiles(report) {
    const t = report.totals;
    const unpricedNote = t.unpriced ? `${t.unpriced} span(s) have no rate` : 'every span priced';
    const tiles = [
      ['Estimated cost', usd(t.cost), unpricedNote],
      ['Sandbox hours', hours(report.drivers.filter((d) => d.driver !== 'fly-machine').reduce((a, d) => a + d.seconds, 0)), `${t.sandboxes} sandbox(es) opened`],
      ['Machine hours', hours(report.drivers.filter((d) => d.driver === 'fly-machine').reduce((a, d) => a + d.seconds, 0)), `${t.machineSpans} stretch(es) seen running`],
    ];
    $('infraTiles').innerHTML = tiles.map(([k, v, s]) => `<div class="card stat"><div class="label">${esc(k)}</div><div class="num">${esc(v)}</div><div class="sub muted">${esc(s)}</div></div>`).join('');
  }

  function drawTables(report) {
    const none = (cols) => `<tr><td colspan="${cols}" class="muted">Nothing in this range.</td></tr>`;
    $('infraDrivers').innerHTML = report.drivers.map((d) => `<tr><td>${esc(kindName(d.driver))}</td><td class="r">${d.spans}</td><td class="r">${hours(d.seconds)}</td><td class="r">${usd(d.cost)}</td><td class="r">${d.unpriced || ''}</td></tr>`).join('') || none(5);
    $('infraOwners').innerHTML = report.owners.map((o) => `<tr><td>${esc(o.owner || '(no person)')}</td><td class="r">${o.spans}</td><td class="r">${hours(o.seconds)}</td><td class="r">${usd(o.cost)}</td></tr>`).join('') || none(4);
    $('infraRecent').innerHTML = report.recent.map((r) => {
      const started = new Date(r.start).toLocaleString();
      const state = r.open ? 'running' : r.recovered ? 'ended (runner restarted)' : 'ended';
      const size = r.kind === 'machine' ? r.size : r.cpus ? `${r.cpus} vCPU · ${r.memMb || '?'} MB` : 'default';
      return `<tr><td>${esc(started)}</td><td>${esc(kindName(r.driver))}</td><td title="${esc(r.id)}">${esc(r.name || r.id)}${r.runId ? ` <span class="muted">· ${esc(r.runId)}</span>` : ''}</td><td>${esc(size)}</td><td class="r">${Math.round(r.seconds / 60)}</td><td class="r">${r.unpriced ? '<span class="muted">no rate</span>' : usd(r.cost)}</td><td>${esc(state)}</td></tr>`;
    }).join('') || none(7);
  }

  function drawRates(report) {
    const r = report.rates;
    const e = r.e2b;
    const parts = [
      `E2B: ${e.vcpuSec ? `$${e.vcpuSec}/vCPU-s` : 'no rate'}, ${e.gibSec ? `$${e.gibSec}/GiB-s` : 'no rate'}, default ${e.cpus} vCPU and ${e.memMb} MB`,
      `Fly Sprites: ${r.sprites.vcpuSec ? 'rate set' : 'no rate (unpriced)'}`,
      `Fly Machines: ${Object.keys(r.machines).length ? Object.keys(r.machines).join(', ') : 'no rate (unpriced)'}`,
    ];
    const err = r.error ? ` ${r.error}` : '';
    $('infraRates').textContent = `Rates from ${r.source}. ${parts.join('. ')}. Set them with SANDBOX_RATES or sandbox-rates.json on the server.${err}`;
  }

  function show(report) {
    if (!report.available) {
      $('infraNotice').hidden = false;
      $('infraNotice').textContent = report.reason || 'The sandbox usage is not available.';
      $('infraTiles').innerHTML = '';
      $('infraDrivers').innerHTML = $('infraOwners').innerHTML = $('infraRecent').innerHTML = '';
      $('infraChart').textContent = '';
      $('infraLegend').textContent = '';
      $('infraRates').textContent = '';
      return;
    }
    $('infraNotice').hidden = true;
    drawTiles(report);
    drawChart(report);
    drawTables(report);
    drawRates(report);
  }

  async function load() {
    document.querySelectorAll('#infraRange button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.days)));
    try {
      const res = await fetch(`/ui/api/admin/infra-usage?days=${state.days}`, { cache: 'no-store' });
      const body = await res.json();
      show(res.ok ? body : { available: false, reason: body.error || `Could not load (${res.status}).` });
    } catch (err) {
      show({ available: false, reason: `Could not load the sandbox usage: ${err.message}` });
    }
  }

  $('infraRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    state.days = Number(b.dataset.days);
    saveView();
    load();
  });

  load();
})();
