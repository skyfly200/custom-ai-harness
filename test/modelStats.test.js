// Model quality, speed, price and strengths: benchmarks matched to Gateway
// models, catalog strengths, and what the user typed winning over both.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stats-'));
process.env.HARNESS_MODEL_STATS_FILE = path.join(dir, 'model-stats.json');
const stats = require('../utils/modelStats');

const AA = {
    status: 200,
    data: [
        {
            id: 'a1', name: 'GPT-4o mini', slug: 'gpt-4o-mini', model_creator: { slug: 'openai' },
            evaluations: { artificial_analysis_intelligence_index: 36.2, artificial_analysis_coding_index: 23.1, artificial_analysis_math_index: 40 },
            pricing: { price_1m_input_tokens: 0.15, price_1m_output_tokens: 0.6, price_1m_blended_3_to_1: 0.26 },
            median_output_tokens_per_second: 160.4, median_time_to_first_token_seconds: 0.5,
        },
        { id: 'a2', name: 'gpt-oss-120B (high)', slug: 'gpt-oss-120b', evaluations: { artificial_analysis_intelligence_index: 58 }, pricing: {} },
        { name: 'no slug' },
    ],
};

const MODELS = {
    'fast-openrouter': { upstream: 'openrouter/openai/gpt-4o-mini', inputCost: 0.15e-6, outputCost: 0.6e-6, free: false, local: false, maxInput: 128000 },
    'fallback-groq': { upstream: 'groq/openai/gpt-oss-120b', inputCost: null, outputCost: null, free: false, local: false },
    'local-engine': { upstream: 'openai/local-model', inputCost: 0, outputCost: 0, free: true, local: 'engine' },
};
const CATALOG = [{ id: 'openai/gpt-4o-mini', tools: true, reasoning: false, inputs: ['text', 'image'], context: 128000 }];

test('benchmarks are read from the Artificial Analysis shape', () => {
    const list = stats.fromArtificialAnalysis(AA);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], {
        id: 'a1', slug: 'gpt-4o-mini', name: 'GPT-4o mini', creator: 'openai', intelligence: 36.2, coding: 23.1, math: 40,
        inPrice: 0.15, outPrice: 0.6, speed: 160.4, ttft: 0.5,
    });
});

test('provider model ids find their benchmark', () => {
    const list = stats.fromArtificialAnalysis(AA);
    assert.equal(stats.matchKey('openrouter/qwen/Qwen3-Coder:free'), 'qwen3-coder');
    assert.equal(stats.findBenchmark(list, 'openrouter/openai/gpt-4o-mini').slug, 'gpt-4o-mini');
    assert.equal(stats.findBenchmark(list, 'groq/openai/gpt-oss-120b').slug, 'gpt-oss-120b');
    assert.equal(stats.findBenchmark(list, 'openai/local-model'), null);
    assert.equal(stats.findBenchmark(list, 'anything', 'gpt-oss-120b').slug, 'gpt-oss-120b');
});

test('stats combine prices, benchmarks and catalog strengths', () => {
    const out = stats.build(MODELS, CATALOG, stats.fromArtificialAnalysis(AA));
    const fast = out['fast-openrouter'];
    assert.equal(fast.quality, 36.2);
    assert.equal(fast.qualityFrom, 'benchmark');
    assert.equal(fast.inPrice, 0.15);
    assert.equal(fast.blended, 0.2625);
    assert.equal(fast.speed, 160);
    assert.deepEqual(fast.strengths.sort(), ['fast', 'images', 'tools']);
    assert.equal(out['fallback-groq'].quality, 58);
    assert.equal(out['fallback-groq'].inPrice, null);
    assert.deepEqual(out['local-engine'].strengths.sort(), ['free', 'local']);
    assert.equal(out['local-engine'].quality, null);
    // with no benchmark list, only prices and catalog tags
    assert.equal(stats.build(MODELS, CATALOG, null)['fast-openrouter'].quality, null);
});

test('what the user saves wins, and clearing it goes back to the benchmark', () => {
    stats.set('fast-openrouter', { quality: 40, strengths: ['Coding', 'cheap', 'coding'] });
    let out = stats.build(MODELS, CATALOG, stats.fromArtificialAnalysis(AA))['fast-openrouter'];
    assert.equal(out.quality, 40);
    assert.equal(out.qualityFrom, 'you');
    assert.deepEqual(out.strengths, ['coding', 'cheap']);
    assert.equal(out.edited, true);
    stats.load();
    assert.equal(stats.build(MODELS, CATALOG, null)['fast-openrouter'].quality, 40, 'kept in the file');
    stats.set('fast-openrouter', {});
    out = stats.build(MODELS, CATALOG, stats.fromArtificialAnalysis(AA))['fast-openrouter'];
    assert.equal(out.quality, 36.2);
    assert.equal(out.edited, false);
    assert.throws(() => stats.set('fast-openrouter', { quality: 101 }), /0 to 100/);
    assert.throws(() => stats.set('bad name', {}), /model name/);
});
