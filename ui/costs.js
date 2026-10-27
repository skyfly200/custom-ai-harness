// What usage cost, and what it would have cost sent straight to Claude Sonnet 5.5.
// Shared by the Usage page and the Dashboard; works in the page
// (window.Costs) and in Node tests (require).
(function (root) {
  // Claude Sonnet 5.5 on Anthropic's API, dollars per token: $2 in, $10 out,
  // cache reads $0.20 and 5-minute cache writes $2.50 per million
  const SONNET = { id: 'sonnet', name: 'Claude Sonnet 5.5', inputCost: 2e-6, outputCost: 10e-6, cacheReadCost: 0.2e-6, cacheWriteCost: 2.5e-6 };

  // Cache prices as a share of the input price, for models whose price list
  // doesn't give them: Anthropic reads at a tenth and writes at 1.25x, others
  // read at their usual discount and don't charge for writes.
  function cacheShares(upstream = '') {
    const m = String(upstream).toLowerCase();
    if (/claude|anthropic/.test(m)) return { read: 0.1, write: 1.25 };
    if (/deepseek/.test(m)) return { read: 0.1, write: 1 };
    if (/gemini|google/.test(m)) return { read: 0.25, write: 1 };
    return { read: 0.5, write: 1 };
  }

  /**
   * Cost of one usage row ({ input, output, cacheRead, cacheWrite }, where
   * input counts cached tokens too) at a model's prices from /ui/api/model-info.
   *   cost:     what was billed, cached input at the cache price
   *   listCost: the same tokens with no cache discount
   * Free models cost 0; unpriced is true when the price isn't known.
   */
  function rowCost(r, p) {
    if (p?.free) return { cost: 0, listCost: 0, free: true, unpriced: false };
    if (!p || p.inputCost == null) return { cost: 0, listCost: 0, free: false, unpriced: true };
    const share = cacheShares(p.upstream);
    const read = p.cacheReadCost ?? p.inputCost * share.read;
    const write = p.cacheWriteCost ?? p.inputCost * share.write;
    const cacheRead = r.cacheRead || 0, cacheWrite = r.cacheWrite || 0;
    const fresh = Math.max(0, (r.input || 0) - cacheRead - cacheWrite);
    const out = (r.output || 0) * (p.outputCost || 0);
    return {
      cost: fresh * p.inputCost + cacheRead * read + cacheWrite * write + out,
      listCost: (r.input || 0) * p.inputCost + out,
      free: false,
      unpriced: false,
    };
  }

  // Adds cost, listCost, unpriced (requests) and freeRequests to each row,
  // priced by the model that answered
  function priceRows(rows, prices) {
    for (const r of rows) {
      const c = rowCost(r, prices?.[r.servedBy]);
      r.cost = c.cost;
      r.listCost = c.listCost;
      r.unpriced = c.unpriced ? r.requests : 0;
      r.freeRequests = c.free ? r.requests : 0;
    }
    return rows;
  }

  // Claude baselines on Anthropic's API, dollars per token (list prices checked
  // 2026-10-27): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per
  // million. Cache reads $0.20 for Opus and Sonnet; Haiku's ($0.01) and the
  // writes (1.25x input) follow Anthropic's usual ratios. Haiku's prices are for
  // prompts up to 100K tokens; longer ones cost five times as much, not modeled.
  const OPUS = { id: 'opus', name: 'Claude Opus 5.5', inputCost: 4e-6, outputCost: 20e-6, cacheReadCost: 0.2e-6, cacheWriteCost: 5e-6 };
  const HAIKU = { id: 'haiku', name: 'Claude Haiku 5.5', inputCost: 0.1e-6, outputCost: 0.5e-6, cacheReadCost: 0.01e-6, cacheWriteCost: 0.125e-6 };
  const BASELINES = [OPUS, SONNET, HAIKU];

  // How many tokens a model needs to get the same work done, relative to
  // Claude Sonnet 5.5 = 1. Not measured: a cheaper model that needs more turns,
  // retries or longer answers uses more tokens for the same result. These are
  // starting guesses for the Usage page to let you edit. perModel overrides by
  // the name of the model that answered.
  const ASSUMED = { opus: 0.9, sonnet: 1, haiku: 1.2, other: 1.2, free: 1.4, perModel: {} };
  const NEUTRAL = { opus: 1, sonnet: 1, haiku: 1, other: 1, free: 1, perModel: {} };

  function multiplier(model, a = NEUTRAL, free = false) {
    const own = a.perModel?.[model];
    if (own > 0) return own;
    const m = String(model).toLowerCase();
    if (/opus/.test(m)) return a.opus;
    if (/haiku/.test(m)) return a.haiku;
    if (/sonnet|claude|anthropic/.test(m)) return a.sonnet;
    return free ? a.free : a.other;
  }

  // Assumptions saved in the browser, so the Dashboard and Usage page agree
  const STORE = 'usage-assumptions';
  function loadAssumptions() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
      return { ...ASSUMED, ...saved, perModel: { ...(saved.perModel || {}) } };
    } catch { return { ...ASSUMED, perModel: {} }; }
  }
  function saveAssumptions(a) { try { localStorage.setItem(STORE, JSON.stringify(a)); } catch {} }

  // The parts of the stack that save, in the order they act on a request.
  // basis: how sure the number is. group: model choice, routing or technique.
  const LAYERS = [
    { id: 'compression', label: 'Compression', group: 'technique', basis: 'estimated', what: 'Headroom and context anchor trim tool results before they are sent' },
    { id: 'tokens', label: 'Tokens needed (modeled)', group: 'tokens', basis: 'assumed', what: 'The answering model using more or fewer tokens than the baseline model for the same work' },
    { id: 'router', label: 'Router', group: 'routing', basis: 'measured', what: 'The Router sends simpler requests to cheaper or free models' },
    { id: 'pinned', label: 'Pinned and chosen models', group: 'model', basis: 'measured', what: 'Models pinned in settings or a routing, or picked in the chat page' },
    { id: 'down', label: 'Router-down model', group: 'routing', basis: 'measured', what: 'The model used while the Router was unreachable' },
    { id: 'fallback', label: 'Gateway fallbacks', group: 'routing', basis: 'measured', what: 'Requests another model answered after the first one failed' },
    { id: 'caching', label: 'Prompt caching', group: 'technique', basis: 'measured', what: 'Repeated input read from the provider’s cache at a lower price' },
  ];
  const GROUPS = [
    { id: 'model', label: 'Model choice', what: 'Models you pinned or picked, priced against the baseline on the tokens they used' },
    { id: 'routing', label: 'Routing', what: 'The Router, its down model and Gateway fallbacks choosing a cheaper model' },
    { id: 'technique', label: 'Techniques', what: 'Compression and prompt caching' },
    { id: 'tokens', label: 'Tokens needed', what: 'Modeled: how many more tokens other models needed for the same work' },
  ];

  // Which layer chose the model a row was served by
  function modelLayer(r) {
    if (r.servedBy && r.model && r.servedBy !== r.model) return 'fallback';
    if (r.route === 'Router') return 'router';
    if (r.route === 'Router down') return 'down';
    return 'pinned';
  }

  /**
   * Savings of priced rows (see priceRows) against sending the same work
   * straight to a Claude baseline (Sonnet 5.5 by default) with no compression
   * and no caching. With k = baseline tokens per token the answering model
   * used (from the assumptions; 1 when none are given):
   *   baseline - compression - tokens needed - model choice (per layer) - caching = actual
   * Compression is the trimmed tokens at the baseline's price. Tokens needed is
   * the baseline's price for the tokens actually used, times (k - 1): negative
   * when the harness's model needed more tokens than the baseline would.
   * Model choice is that baseline price minus the answering model's undiscounted
   * price; caching is that minus what was billed. A layer that cost more than
   * the baseline would have comes out negative. Rows with no known price are
   * left out and counted in `unpriced`.
   */
  function savings(rows, base = SONNET, a = NEUTRAL) {
    const layers = Object.fromEntries(LAYERS.map(l => [l.id, { ...l, saved: 0, tokens: 0, requests: 0 }]));
    const t = { baseline: 0, baselineCached: 0, actual: 0, unpriced: 0, requests: 0, trimmed: 0, anchor: 0, headroom: 0 };
    const mB = a[base.id] > 0 ? a[base.id] : 1;
    for (const r of rows) {
      if (r.unpriced) { t.unpriced += r.unpriced; continue; }
      const anchor = r.savedAnchor || 0, headroom = r.savedHeadroom || 0, trimmed = anchor + headroom;
      const cacheRead = r.cacheRead || 0, cacheWrite = r.cacheWrite || 0;
      const k = mB / multiplier(r.servedBy, a, r.freeRequests > 0);
      const same = r.input * base.inputCost + r.output * base.outputCost; // baseline price for the tokens used
      t.requests += r.requests;
      t.baseline += (same + trimmed * base.inputCost) * k;
      t.baselineCached += (Math.max(0, r.input + trimmed - cacheRead - cacheWrite) * base.inputCost
        + cacheRead * base.cacheReadCost + cacheWrite * base.cacheWriteCost + r.output * base.outputCost) * k;
      t.actual += r.cost;
      t.trimmed += trimmed; t.anchor += anchor; t.headroom += headroom;

      const c = layers.compression;
      c.saved += trimmed * base.inputCost * k; c.tokens += trimmed; if (trimmed) c.requests += r.requests;

      const x = layers.tokens;
      x.saved += same * (k - 1); x.tokens += (r.input + r.output) * (1 - k);
      if (Math.abs(k - 1) > 1e-9) x.requests += r.requests;

      const m = layers[modelLayer(r)];
      m.saved += same - r.listCost; m.requests += r.requests;
      if (r.freeRequests) m.tokens += r.input + r.output;

      const q = layers.caching;
      q.saved += r.listCost - r.cost; q.tokens += cacheRead; if (cacheRead) q.requests += r.requests;
    }
    t.saved = t.baseline - t.actual;
    t.savedCached = t.baselineCached - t.actual;
    t.layers = LAYERS.map(l => layers[l.id]);
    t.groups = GROUPS.map(g => ({ ...g, saved: t.layers.filter(l => l.group === g.id).reduce((sum, l) => sum + l.saved, 0) }));
    t.base = base;
    return t;
  }

  // Dollars: whole for big sums, cents below $100, and two significant digits
  // for fractions of a cent, so a small cost never shows as $0.0000
  function usd(n) {
    if (!Number.isFinite(n) || n === 0) return '$0';
    const sign = n < 0 ? '−' : '';
    const a = Math.abs(n);
    if (a >= 100) return `${sign}$${Math.round(a).toLocaleString()}`;
    if (a >= 0.01) return `${sign}$${a.toFixed(2)}`;
    if (a < 1e-6) return `${sign}<$0.000001`;
    return `${sign}$${a.toFixed(Math.min(6, 1 - Math.floor(Math.log10(a))))}`;
  }

  const api = { SONNET, OPUS, HAIKU, BASELINES, ASSUMED, NEUTRAL, LAYERS, GROUPS, cacheShares, rowCost, priceRows, modelLayer, multiplier, loadAssumptions, saveAssumptions, savings, usd };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Costs = api;
})(typeof window !== 'undefined' ? window : globalThis);
