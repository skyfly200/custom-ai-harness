// Prices and context sizes of the Gateway's models, for the chat page's cost
// and context readouts. LiteLLM's /v1/model/info has them per deployment;
// when it can't be reached, config.yaml still says which models are free.

// Free: OpenRouter ":free" models and its free router, and anything served
// from this machine (the CLI wrapper, Laya, Ollama)
function isFree(model = '', apiBase = '') {
    return /:free\b|^openrouter\/(openrouter\/)?free$|-free\b/.test(model)
        || /localhost|127\.0\.0\.1/.test(apiBase)
        || /^ollama(_chat)?\//.test(model);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// LiteLLM /v1/model/info -> { model_name: { maxInput, maxOutput, inputCost, outputCost, free } }
// Costs are dollars per token. Several deployments of one name keep the first.
function fromGatewayInfo(data) {
    const models = {};
    for (const d of data || []) {
        const name = d.model_name;
        if (!name || models[name]) continue;
        const info = d.model_info || {};
        const params = d.litellm_params || {};
        const inputCost = num(info.input_cost_per_token);
        const outputCost = num(info.output_cost_per_token);
        const free = isFree(params.model, params.api_base) || (inputCost === 0 && outputCost === 0);
        models[name] = {
            maxInput: num(info.max_input_tokens) ?? num(info.max_tokens),
            maxOutput: num(info.max_output_tokens),
            inputCost: free ? 0 : inputCost,
            outputCost: free ? 0 : outputCost,
            free,
        };
    }
    return models;
}

// config.yaml without a YAML library: model_name, model and api_base lines
function fromConfig(text) {
    const models = {};
    let current = null;
    const finish = () => {
        if (current?.model_name && !models[current.model_name]) {
            const free = isFree(current.model, current.api_base);
            models[current.model_name] = { maxInput: null, maxOutput: null, inputCost: free ? 0 : null, outputCost: free ? 0 : null, free };
        }
    };
    for (const line of String(text).split(/\r?\n/)) {
        const entry = line.match(/^\s*-\s*model_name:\s*["']?([^"'\s#]+)/);
        if (entry) { finish(); current = { model_name: entry[1] }; continue; }
        if (/^\S/.test(line)) { finish(); current = null; continue; }
        const field = current && line.match(/^\s+(model|api_base):\s*["']?([^"'\s#]+)/);
        if (field) current[field[1]] = field[2];
    }
    finish();
    return models;
}

module.exports = { isFree, fromGatewayInfo, fromConfig };
