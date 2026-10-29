// The sums behind the "All users" usage page (usage-users.html), kept apart from the page so tests can run them.
// Input is GET /ui/api/admin/usage; rows are priced like the Usage page prices them (ui/costs.js).
(function (root) {
  const Costs = root.Costs || (typeof require === 'function' ? require('./costs') : null);
  const lower = (s) => String(s || '').toLowerCase();

  const valueOf = (r, measure) => (measure === 'cost' ? r.cost || 0 : measure === 'tokens' ? (r.input || 0) + (r.output || 0) : r.requests || 0);

  const blank = (user) => ({
    user, requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, unpriced: 0, free: 0, agentCost: 0, agentRequests: 0,
    last: null, role: null, guest: false, credit: null, models: [],
  });

  /**
   * One entry per person, in the order the server gave them (people with no usage in the range included):
   * requests, tokens, cost (unpriced: requests on models with no known price), agentCost (the part spent by
   * agent runs), the three busiest models, when they were last active, and a guest's credit.
   */
  function aggregate(data, prices) {
    const rows = Costs.priceRows((data.rows || []).map((r) => ({ ...r })), prices);
    const people = new Map();
    const get = (user) => {
      const key = lower(user);
      if (!people.has(key)) people.set(key, blank(user || ''));
      return people.get(key);
    };
    for (const p of data.people || []) {
      const e = get(p.name);
      e.user = p.name; e.role = p.role; e.guest = Boolean(p.guest);
    }
    const models = new Map();
    for (const r of rows) {
      const p = get(r.user);
      p.requests += r.requests; p.input += r.input; p.output += r.output; p.cacheRead += r.cacheRead;
      p.cost += r.cost; p.unpriced += r.unpriced; p.free += r.freeRequests;
      if (r.client === 'Agent run') { p.agentCost += r.cost; p.agentRequests += r.requests; }
      const m = models.get(lower(r.user)) || new Map();
      const one = m.get(r.servedBy) || { name: r.servedBy, requests: 0, tokens: 0, cost: 0 };
      one.requests += r.requests; one.tokens += r.input + r.output; one.cost += r.cost;
      m.set(r.servedBy, one);
      models.set(lower(r.user), m);
    }
    for (const u of data.users || []) {
      const p = get(u.user);
      p.last = u.last;
    }
    for (const [key, p] of people) {
      p.models = [...(models.get(key)?.values() || [])].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
      const credit = Object.entries(data.credit || {}).find(([name]) => lower(name) === key);
      if (credit) {
        p.credit = credit[1];
        p.left = credit[1].leftUsd;
      }
    }
    const list = [...people.values()];
    const total = list.reduce((t, p) => {
      for (const k of ['requests', 'input', 'output', 'cacheRead', 'cost', 'unpriced', 'free', 'agentCost']) t[k] += p[k];
      if (p.requests) t.active++;
      return t;
    }, { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, unpriced: 0, free: 0, agentCost: 0, active: 0 });
    return { people: list, total, rows };
  }

  const SORTS = {
    name: (a, b) => lower(a.user).localeCompare(lower(b.user)),
    requests: (a, b) => a.requests - b.requests,
    input: (a, b) => a.input - b.input,
    output: (a, b) => a.output - b.output,
    cost: (a, b) => a.cost - b.cost,
    agentCost: (a, b) => a.agentCost - b.agentCost,
    last: (a, b) => String(a.last || '').localeCompare(String(b.last || '')),
    left: (a, b) => (a.left ?? Infinity) - (b.left ?? Infinity),
  };

  /** A sorted copy. dir is 1 (low to high) or -1. Ties fall back to name, and people with nothing to compare go last. */
  function sorted(people, key, dir) {
    const cmp = SORTS[key] || SORTS.name;
    const missing = (p) => (key === 'last' ? !p.last : key === 'left' ? p.left == null : false);
    return [...people].sort((a, b) => {
      if (missing(a) !== missing(b)) return missing(a) ? 1 : -1;
      return (cmp(a, b) * dir) || SORTS.name(a, b);
    });
  }

  /** The days to chart, oldest first: the last `days` ending `today`, or (0) from the first day with usage. */
  function dayList(days, first, today) {
    const end = Date.parse(today);
    const n = days > 0 ? days : Math.max(1, Math.round((end - Date.parse(first || today)) / 86400000) + 1);
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
    return out;
  }

  /**
   * Priced daily rows to stacked bars: { days, series: [{ key, label, values: [one per day], total }] }, `series`
   * the `top` biggest groups by `keyOf(row)`, the rest merged into "Others".
   */
  function stack(daily, { days, today, measure, keyOf, labelOf = (k) => k, top = 6 }) {
    const rows = daily || [];
    const list = dayList(days, rows[0]?.day, today);
    const index = new Map(list.map((d, i) => [d, i]));
    const groups = new Map();
    for (const r of rows) {
      const i = index.get(r.day);
      if (i === undefined) continue;
      const key = keyOf(r);
      const g = groups.get(key) || { key, label: labelOf(key), values: list.map(() => 0), total: 0 };
      const v = valueOf(r, measure);
      g.values[i] += v; g.total += v;
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) => b.total - a.total);
    const series = ordered.slice(0, top);
    if (ordered.length > top) {
      const others = { key: '\u0000others', label: 'Others', values: list.map(() => 0), total: 0, others: true };
      for (const g of ordered.slice(top)) { g.values.forEach((v, i) => { others.values[i] += v; }); others.total += g.total; }
      series.push(others);
    }
    return { days: list, series };
  }

  const api = { aggregate, sorted, stack, dayList, valueOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UserUsage = api;
})(typeof window !== 'undefined' ? window : globalThis);
