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

  const api = { autoRoute };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AutoRoute = api;
})(typeof window !== 'undefined' ? window : globalThis);
