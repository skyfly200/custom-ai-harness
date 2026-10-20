// What usage cost, and what it would have cost sent straight to Claude Sonnet 5.5.
// Shared by the Usage page and the Dashboard; works in the page
// (window.Costs) and in Node tests (require).
(function (root) {
  // Claude Sonnet 5.5 on Anthropic's API, dollars per token: $2 in, $10 out,
  // cache reads $0.20 and 5-minute cache writes $2.50 per million
  const SONNET = { name: 'Claude Sonnet 5.5', inputCost: 2e-6, outputCost: 10e-6, cacheReadCost: 0.2e-6, cacheWriteCost: 2.5e-6 };

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

  // The parts of the stack that save, in the order they act on a request
  const LAYERS = [
    { id: 'compression', label: 'Compression', what: 'Headroom and context anchor trim tool results before they are sent' },
    { id: 'router', label: 'Router', what: 'The Router sends simpler requests to cheaper or free models' },
    { id: 'pinned', label: 'Pinned and chosen models', what: 'Models pinned in settings or a routing, or picked in the chat page' },
    { id: 'down', label: 'Router-down model', what: 'The model used while the Router was unreachable' },
    { id: 'fallback', label: 'Gateway fallbacks', what: 'Requests another model answered after the first one failed' },
    { id: 'caching', label: 'Prompt caching', what: 'Repeated input read from the provider’s cache at a lower price' },
  ];

  // Which layer chose the model a row was served by
  function modelLayer(r) {
    if (r.servedBy && r.model && r.servedBy !== r.model) return 'fallback';
    if (r.route === 'Router') return 'router';
    if (r.route === 'Router down') return 'down';
    return 'pinned';
  }

  /**
   * Savings of priced rows (see priceRows) against sending the same requests
   * straight to Claude Sonnet 5.5 with no compression and no caching:
   *   baseline - compression - model choice (per layer) - caching = actual
   * Model choice is Sonnet's price for the tokens sent minus the answering
   * model's undiscounted price; caching is that minus what was billed. A layer
   * that cost more than Sonnet would have comes out negative.
   * Rows with no known price are left out and counted in `unpriced`.
   */
  function savings(rows, base = SONNET) {
    const layers = Object.fromEntries(LAYERS.map(l => [l.id, { ...l, saved: 0, tokens: 0, requests: 0 }]));
    const t = { baseline: 0, baselineCached: 0, actual: 0, unpriced: 0, requests: 0, trimmed: 0, anchor: 0, headroom: 0 };
    for (const r of rows) {
      if (r.unpriced) { t.unpriced += r.unpriced; continue; }
      const anchor = r.savedAnchor || 0, headroom = r.savedHeadroom || 0, trimmed = anchor + headroom;
      const cacheRead = r.cacheRead || 0, cacheWrite = r.cacheWrite || 0;
      const sonnet = r.input * base.inputCost + r.output * base.outputCost;
      t.requests += r.requests;
      t.baseline += sonnet + trimmed * base.inputCost;
      t.baselineCached += Math.max(0, r.input + trimmed - cacheRead - cacheWrite) * base.inputCost
        + cacheRead * base.cacheReadCost + cacheWrite * base.cacheWriteCost + r.output * base.outputCost;
      t.actual += r.cost;
      t.trimmed += trimmed; t.anchor += anchor; t.headroom += headroom;

      const c = layers.compression;
      c.saved += trimmed * base.inputCost; c.tokens += trimmed; if (trimmed) c.requests += r.requests;

      const m = layers[modelLayer(r)];
      m.saved += sonnet - r.listCost; m.requests += r.requests;
      if (r.freeRequests) m.tokens += r.input + r.output;

      const k = layers.caching;
      k.saved += r.listCost - r.cost; k.tokens += cacheRead; if (cacheRead) k.requests += r.requests;
    }
    t.saved = t.baseline - t.actual;
    t.savedCached = t.baselineCached - t.actual;
    t.layers = LAYERS.map(l => layers[l.id]);
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

  const api = { SONNET, LAYERS, cacheShares, rowCost, priceRows, modelLayer, savings, usd };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Costs = api;
})(typeof window !== 'undefined' ? window : globalThis);
