// OpenRouter's model catalog (GET https://openrouter.ai/api/v1/models, no key
// needed), trimmed for the routing editor's model picker: the chat models only,
// with prices, context size, what they take in and what they can do.

const num = (v) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

// /api/v1/models body -> [{ id, name, context, inputCost, outputCost, free, tools, created, ... }]
// Costs are dollars per token (imageCost per image, requestCost per request).
// Newest first. Models that can't answer in text
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
        const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.filter(p => typeof p === 'string') : [];
        const price = (v) => (free ? 0 : (n => (n !== null && n >= 0 ? n : null))(num(v)));
        out.push({
            id: m.id,
            name: m.name || m.id,
            context: num(m.context_length) ?? num(m.top_provider?.context_length),
            inputCost: free ? 0 : (inputCost !== null && inputCost >= 0 ? inputCost : null),
            outputCost: free ? 0 : (outputCost !== null && outputCost >= 0 ? outputCost : null),
            free,
            tools: params.includes('tools'),
            created: num(m.created) || 0,
            provider: m.id.split('/')[0],
            description: typeof m.description === 'string' ? m.description.slice(0, 1200) : '',
            maxOutput: num(m.top_provider?.max_completion_tokens),
            cacheReadCost: price(m.pricing?.input_cache_read),
            reasoningCost: price(m.pricing?.internal_reasoning),
            imageCost: price(m.pricing?.image),
            requestCost: price(m.pricing?.request),
            inputs: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ['text'],
            outputs: Array.isArray(outputs) && outputs.length ? outputs : ['text'],
            reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
            structured: params.includes('structured_outputs') || params.includes('response_format'),
            params,
            tokenizer: m.architecture?.tokenizer || null,
            moderated: m.top_provider?.is_moderated === true,
            huggingFace: m.hugging_face_id || null,
        });
    }
    return out.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

module.exports = { fromCatalog };
