// OpenRouter's model catalog (GET https://openrouter.ai/api/v1/models, no key
// needed), trimmed for the routing editor's model picker: the chat models only,
// with price, context size and whether they take tool calls.

const num = (v) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

// /api/v1/models body -> [{ id, name, context, inputCost, outputCost, free, tools, created }]
// Costs are dollars per token. Newest first. Models that can't answer in text
// (speech, image and embedding models) are left out.
function fromCatalog(body) {
    const out = [];
    for (const m of body?.data || []) {
        if (!m?.id || typeof m.id !== 'string') continue;
        const outputs = m.architecture?.output_modalities;
        if (Array.isArray(outputs) && outputs.length && !outputs.includes('text')) continue;
        const inputCost = num(m.pricing?.prompt);
        const outputCost = num(m.pricing?.completion);
        // A price of -1 means "varies" (OpenRouter's routers); only :free ids and
        // all-zero prices count as free.
        const free = m.id.endsWith(':free') || m.id === 'openrouter/free' || (inputCost === 0 && outputCost === 0);
        out.push({
            id: m.id,
            name: m.name || m.id,
            context: num(m.context_length) ?? num(m.top_provider?.context_length),
            inputCost: free ? 0 : (inputCost !== null && inputCost >= 0 ? inputCost : null),
            outputCost: free ? 0 : (outputCost !== null && outputCost >= 0 ? outputCost : null),
            free,
            tools: (m.supported_parameters || []).includes('tools'),
            created: num(m.created) || 0,
        });
    }
    return out.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

module.exports = { fromCatalog };
