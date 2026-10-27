// What a task-runner run spends. The runner asks the harness for the same
// model prices the Usage page uses (/ui/api/model-info) and prices each model
// call from its usage; a cost the provider reported (OpenRouter's usage.cost)
// wins over the computed one. Models with no known price count as unpriced.

const Costs = require('../ui/costs');
const Tokens = require('../ui/tokens');

const REFRESH_MS = 5 * 60 * 1000;

// usage: the reply's usage object; prices: model-info's `models`
function callCost(usage, model, prices) {
    const u = Tokens.usage(usage);
    if (!u) return { cost: 0, unpriced: false };
    if (u.cost != null) return { cost: u.cost, unpriced: false };
    const c = Costs.rowCost(u, prices?.[model]);
    return { cost: c.cost, unpriced: c.unpriced };
}

// Keeps the price list fresh for a runner; refresh() never throws
function createPricer({ url, headers = {}, fetchImpl = fetch, ttlMs = REFRESH_MS }) {
    let prices = null;
    let at = 0;
    let loading = null;
    return {
        async refresh() {
            if (prices && Date.now() - at < ttlMs) return;
            loading ||= (async () => {
                try {
                    const res = await fetchImpl(`${url}/ui/api/model-info`, { headers, signal: AbortSignal.timeout(15000) });
                    const body = res.ok ? await res.json() : null;
                    if (body?.models) prices = body.models;
                } catch { /* keep the old list; calls are counted as unpriced until one loads */ }
                at = Date.now();
            })().finally(() => { loading = null; });
            await loading;
        },
        cost(usage, model) { return callCost(usage, model, prices); },
    };
}

module.exports = { callCost, createPricer };
