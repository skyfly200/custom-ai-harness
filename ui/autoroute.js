// Auto-route: wires the Gateway's models into a strategy by their ratings.
//
// autoRoute() is pure. It takes the model names the Gateway serves, their
// numbers (GET api/model-stats), and the strategy being edited, and returns the
// route choices and fallback lines that make the strategy complete. The Strategy
// page shows them as a preview and applies them only when asked.
//
// Rules: the best-rated model is Strong (and with five or more rated models the
// best becomes a "Frontier" tier above the threshold and the second best is
// Strong); the cheapest of what is left is Weak; with four or more a "Mid" tier
// below the threshold takes the best of the rest. Tools outputs get a model
// that takes tool calls when the main one doesn't. Models with no quality
// rating are never placed; they are returned in `skipped`.
(function (root) {
  const price = (s) => (s.blended ?? s.inPrice ?? Infinity);
  const byQuality = (a, b) => b.s.quality - a.s.quality || price(a.s) - price(b.s);
  const byPrice = (a, b) => price(a.s) - price(b.s) || b.s.quality - a.s.quality;

  /**
   * @param {string[]} served  model names the Gateway serves
   * @param {Object} stats     name -> { quality, blended, inPrice, strengths }
   * @param {Object} r         the strategy: threshold, down, downTools, images, pin
   * @param {Object} fallbacks name -> [fallback names], kept as they are where set
   * @returns {{ routes, tiers, fallbacks, skipped, notes }|null} null with nothing rated
   */
  function autoRoute(served, stats, r = {}, fallbacks = {}) {
    const all = served.map(name => ({ name, s: stats[name] || {} }));
    const rated = all.filter(m => typeof m.s.quality === 'number').sort(byQuality);
    const skipped = all.filter(m => typeof m.s.quality !== 'number').map(m => m.name);
    if (!rated.length) return null;
    const notes = [];
    const has = (m, tag) => (m.s.strengths || []).includes(tag);
    // Nothing tagged with tools means the tag isn't known, so none are ruled out
    const tagged = rated.some(m => has(m, 'tools'));
    const toolsOk = (m) => !tagged || has(m, 'tools');
    if (!tagged) notes.push('No model is marked as taking tool calls, so all are treated as able to.');

    const threshold = r.threshold ?? 0.5;
    const frontier = rated.length >= 5 ? rated[0] : null;
    const rest = rated.slice(frontier ? 1 : 0);
    const strong = rest[0];
    const below = rest.slice(1);
    const weak = (below.length ? [...below].sort(byPrice) : [strong])[0];
    const mid = rated.length >= 4 ? below.filter(m => m !== weak)[0] : null;

    // The model for requests with tools: the same one if it takes them, else the best (or cheapest) that does
    const withTools = (m, cheapest) => {
      if (toolsOk(m)) return null;
      const pool = rated.filter(toolsOk).sort(cheapest ? byPrice : byQuality);
      return pool[0]?.name ?? null;
    };

    const routes = {
      strong: strong.name,
      strongTools: withTools(strong, false),
      weak: weak.name,
      tools: withTools(weak, true),
    };
    const tiers = [];
    if (frontier) tiers.push({ name: 'Frontier', from: Math.min(1, Math.round((threshold + (1 - threshold) / 2) * 100) / 100) || 0.9, model: frontier.name, tools: withTools(frontier, false) });
    if (mid) tiers.push({ name: 'Mid', from: Math.round(threshold * 0.6 * 100) / 100 || 0.3, model: mid.name, tools: withTools(mid, true) });
    const placed = new Set([strong, weak, mid, frontier].filter(Boolean).map(m => m.name));
    if (placed.size < rated.length) notes.push(`${rated.length - placed.size} rated model${rated.length - placed.size === 1 ? ' is' : 's are'} not placed: ${rated.filter(m => !placed.has(m.name)).map(m => m.name).join(', ')}. Add a tier for ${rated.length - placed.size === 1 ? 'it' : 'them'} if wanted.`);

    // Keep what is set and served; otherwise the strongest takes over when the Router is down
    const ok = (name) => name && served.includes(name);
    routes.down = ok(r.down) ? r.down : strong.name;
    routes.downTools = ok(r.downTools) ? r.downTools : (routes.strongTools || strong.name);
    const imageModel = rated.filter(m => has(m, 'images')).sort(byQuality)[0];
    if (!ok(r.images) && imageModel) routes.images = imageModel.name;

    // A fallback for every routed model without one: the next best that is a different model
    const routed = new Set([...Object.values(routes), ...tiers.flatMap(t => [t.model, t.tools])].filter(Boolean));
    const added = {};
    for (const name of routed) {
      if (fallbacks[name]?.length) continue;
      const me = rated.find(m => m.name === name);
      const pick = rated.filter(m => m.name !== name && (!me || toolsOk(m) || !toolsOk(me)))
        .sort((a, b) => Math.abs(a.s.quality - (me?.s.quality ?? 0)) - Math.abs(b.s.quality - (me?.s.quality ?? 0)) || price(a.s) - price(b.s))[0];
      if (pick) added[name] = [pick.name];
    }
    return { routes, tiers, fallbacks: added, skipped, notes };
  }

  // Starting points for a strategy. Each one is autoRoute() run over the models
  // that fit its idea, so a fresh strategy begins different from the others.
  const PRESETS = [
    { id: 'balanced', label: 'Balanced', hint: 'Best model for hard requests, cheapest for easy ones' },
    { id: 'best', label: 'Best quality', hint: 'The top-rated model for every request' },
    { id: 'cheapest', label: 'Cheapest', hint: 'The cheapest rated model for every request' },
    { id: 'fast', label: 'Fast and light', hint: 'Cheap by default; the top-rated model only when the Router is very sure it is needed' },
    { id: 'local', label: 'Local only', hint: 'Only models that run on this computer (local-… names)' },
  ];
  const isLocal = (n) => /^(local|ollama)[-_:\/]/i.test(n);

  /** autoRoute() shaped by a preset. Returns null with nothing to place. Adds `threshold` where the preset sets one. */
  function preset(id, served, stats, r = {}, fallbacks = {}) {
    const rated = served.map(name => ({ name, s: stats[name] || {} })).filter(m => typeof m.s.quality === 'number');
    let pool = served;
    let threshold;
    if (id === 'best') pool = [rated.sort(byQuality)[0]?.name].filter(Boolean);
    else if (id === 'cheapest') pool = [rated.sort(byPrice)[0]?.name].filter(Boolean);
    else if (id === 'local') pool = served.filter(isLocal);
    else if (id === 'fast') { pool = served; threshold = 0.8; }
    if (!pool.length) return null;
    const plan = autoRoute(pool, stats, { ...r, down: null, downTools: null, images: null }, fallbacks);
    if (!plan) return null;
    if (threshold !== undefined) plan.routes.threshold = threshold;
    if (id === 'fast' && rated.length > 2) {
      // Strong is a middle model, not the best: cost stays low even when the Router asks for strong
      const mid = [...rated].sort(byQuality)[Math.floor(rated.length / 3)];
      plan.routes.strong = mid.name;
      plan.routes.strongTools = null;
      plan.routes.down = mid.name;
      plan.routes.downTools = plan.routes.tools || mid.name;
      plan.tiers = [];
    }
    if (pool.length < served.length) {
      // Fallbacks may reach outside the pool except for Local only, which stays on this computer
      const full = id === 'local' ? null : autoRoute(served, stats, r, fallbacks);
      if (full) for (const [m, t] of Object.entries(full.fallbacks)) if (!plan.fallbacks[m] && !fallbacks[m]?.length) plan.fallbacks[m] = t;
    }
    return plan;
  }

  /** One line saying what a strategy does, for the picker and the compare table. */
  function describe(r) {
    const strong = r.strong, weak = r.weak;
    if (!strong && !weak) return r.pin ? `pinned to ${r.pin}` : 'not wired yet';
    if (r.pin) return `pinned to ${r.pin}`;
    if (strong === weak) return `${strong} for everything`;
    return `${strong || '—'} ↔ ${weak || '—'}${r.threshold != null ? ` at ${r.threshold}` : ''}`;
  }

  // Quality numbers for models that have none, so routing can start before any
  // benchmarks are set up: from price when at least two models have one (dearer
  // is better), else from the model's name. Rated models keep their own numbers.
  // Returns { stats, guessed } where guessed lists the names that were estimated.
  const NAME_SCORES = [[/opus|ultra|\bmax\b|frontier|405b/i, 90], [/sonnet|\bpro\b|large|gpt-?[4-9]\b|70b/i, 75],
    [/haiku|mini|flash|lite|small|nano|fast|instant|\b[1-9]b\b|8b/i, 40]];
  const nameScore = (n) => (isLocal(n) ? 35 : (NAME_SCORES.find(([re]) => re.test(n)) || [0, 60])[1]);

  function withGuesses(served, stats) {
    const out = { ...stats };
    const guessed = served.filter(n => typeof stats[n]?.quality !== 'number');
    const priced = served.filter(n => Number.isFinite(price(stats[n] || {})));
    const order = [...priced].sort((a, b) => price(stats[a]) - price(stats[b]));
    for (const n of guessed) {
      const rank = order.indexOf(n);
      const quality = rank >= 0 && order.length >= 2 ? 30 + Math.round(60 * rank / (order.length - 1)) : nameScore(n);
      // With no price either, assume dearer means better so the cheapest pick is the weakest
      out[n] = { ...stats[n], quality, ...(Number.isFinite(price(stats[n] || {})) ? {} : { blended: quality / 10 }), guessed: true };
    }
    return { stats: out, guessed };
  }

  // Strategies with no fallback lines of their own use the Gateway's. Before those
  // are edited, each gets a copy of them, so the edit changes one strategy only.
  function freezeFallbacks(profiles, gateway) {
    for (const p of profiles) if (!p.fallbacks) p.fallbacks = JSON.parse(JSON.stringify(gateway));
  }

  const api = { freezeFallbacks, autoRoute, preset, describe, withGuesses, PRESETS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AutoRoute = api;
})(typeof window !== 'undefined' ? window : globalThis);
