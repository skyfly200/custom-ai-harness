// How good, fast and costly each Gateway model is, so tiers can be laid out
// from cheap to capable and the effort slider has numbers behind it.
//
// Three sources, the first that has a value wins:
//   1. what you typed on the Routing page (model-stats.json, gitignored)
//   2. Artificial Analysis's free benchmark API, when ARTIFICIAL_ANALYSIS_API_KEY
//      is set: intelligence, coding and math indexes, prices, output speed
//      (https://artificialanalysis.ai/, attribution required)
//   3. prices from the Gateway / OpenRouter (utils/modelInfo.js) and what
//      OpenRouter's catalog says a model can do (tools, reasoning, images)
// Strengths are tags (coding, reasoning, tools, images, long context, fast,
// cheap, local, free); new kinds of model only need a new tag.

const fs = require('fs');
const path = require('path');

const FILE = process.env.HARNESS_MODEL_STATS_FILE || path.join(__dirname, '..', 'model-stats.json');
const STRENGTHS = ['coding', 'reasoning', 'tools', 'images', 'long context', 'fast', 'cheap', 'local', 'free', 'writing', 'math'];
const AA_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Artificial Analysis /data/llms/models body -> a flat list. Prices are dollars per million tokens. */
function fromArtificialAnalysis(body) {
    const out = [];
    for (const m of body?.data || []) {
        if (!m || typeof m.slug !== 'string') continue;
        const e = m.evaluations || {};
        const p = m.pricing || {};
        out.push({
            id: m.id || null,
            slug: m.slug,
            name: m.name || m.slug,
            creator: m.model_creator?.slug || null,
            intelligence: num(e.artificial_analysis_intelligence_index),
            coding: num(e.artificial_analysis_coding_index),
            math: num(e.artificial_analysis_math_index),
            inPrice: num(p.price_1m_input_tokens),
            outPrice: num(p.price_1m_output_tokens),
            speed: num(m.median_output_tokens_per_second),
            ttft: num(m.median_time_to_first_token_seconds),
        });
    }
    return out;
}

// "openrouter/qwen/qwen3-coder-30b-a3b:free" -> "qwen3-coder-30b-a3b"
function matchKey(s) {
    return String(s || '').toLowerCase().split('/').pop().replace(/:.*$/, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The benchmark entry for a provider model id, or for the slug the user picked. */
function findBenchmark(list, upstream, slug) {
    if (!list?.length) return null;
    if (slug) return list.find(m => m.slug === slug) || null;
    const key = matchKey(upstream);
    if (!key) return null;
    return list.find(m => m.slug === key) || list.find(m => matchKey(m.name) === key) || null;
}

/** Benchmarks for each OpenRouter catalog id that has some: { id: { slug, name, intelligence, ... } } */
function forCatalog(catalog, bench) {
    const out = {};
    if (!bench?.length) return out;
    for (const m of catalog || []) {
        const b = findBenchmark(bench, m.id);
        if (b) out[m.id] = { slug: b.slug, name: b.name, intelligence: b.intelligence, coding: b.coding, math: b.math, speed: b.speed, ttft: b.ttft, inPrice: b.inPrice, outPrice: b.outPrice };
    }
    return out;
}

/** Tags a model earns from its catalog entry and prices. */
function derivedStrengths(info, catalogEntry, bench) {
    const tags = new Set();
    if (info?.local) tags.add('local');
    if (info?.free) tags.add('free');
    if (catalogEntry?.tools) tags.add('tools');
    if (catalogEntry?.reasoning) tags.add('reasoning');
    if ((catalogEntry?.inputs || []).includes('image')) tags.add('images');
    if ((catalogEntry?.context ?? info?.maxInput ?? 0) >= 200000) tags.add('long context');
    if ((bench?.speed ?? 0) >= 150) tags.add('fast');
    return [...tags];
}

let saved = {};
function load() {
    saved = {};
    try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')).models || {}; } catch {}
}

const score = (k) => (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${k} must be from 0 to 100`);
    return n;
};
const FIELDS = {
    quality: score('Quality'),
    coding: score('Coding'),
    speed: (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Speed must be tokens per second');
        return n;
    },
    strengths: (v) => {
        if (v === null || v === undefined) return null;
        if (!Array.isArray(v)) throw new Error('Strengths must be a list');
        return [...new Set(v.filter(s => typeof s === 'string').map(s => s.trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 12);
    },
    benchmark: (v) => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v !== 'string' || !/^[\w.-]{1,100}$/.test(v)) throw new Error('The benchmark model must be an Artificial Analysis slug');
        return v;
    },
};

/** Save what the user typed for one model; empty values go back to the looked-up ones. */
function set(name, values) {
    if (typeof name !== 'string' || !/^[\w.:/@-]+$/.test(name)) throw new Error('name must be a model name');
    const next = {};
    for (const [k, check] of Object.entries(FIELDS)) {
        const v = check(values?.[k]);
        if (v !== null) next[k] = v;
    }
    if (Object.keys(next).length) saved[name] = next; else delete saved[name];
    fs.writeFileSync(FILE, JSON.stringify({ models: saved }, null, 2) + '\n', 'utf8');
    return saved[name] || null;
}

/**
 * Stats for every Gateway model: `models` from utils/modelInfo.js (costs per
 * token), OpenRouter's `catalog`, the `bench` list from Artificial Analysis.
 */
function build(models, catalog, bench) {
    const byId = new Map((catalog || []).map(m => [m.id, m]));
    const out = {};
    for (const [name, info] of Object.entries(models || {})) {
        const mine = saved[name] || {};
        const orId = /^openrouter\//.test(info.upstream || '') ? info.upstream.replace(/^openrouter\//, '') : null;
        const entry = orId ? byId.get(orId) : null;
        const b = findBenchmark(bench, info.upstream, mine.benchmark);
        const perM = (c) => (c === null || c === undefined ? null : round(c * 1e6, 3));
        const inPrice = perM(info.inputCost) ?? (info.free ? 0 : b?.inPrice ?? null);
        const outPrice = perM(info.outputCost) ?? (info.free ? 0 : b?.outPrice ?? null);
        const pick = (k, fromBench) => (mine[k] !== undefined ? [mine[k], 'you'] : fromBench !== null && fromBench !== undefined ? [fromBench, 'benchmark'] : [null, null]);
        const [quality, qualityFrom] = pick('quality', b?.intelligence);
        const [coding] = pick('coding', b?.coding);
        const [speed] = pick('speed', b?.speed);
        const derived = derivedStrengths(info, entry, b);
        const strengths = mine.strengths || derived;
        if (inPrice === 0 && outPrice === 0 && !strengths.includes('free') && !mine.strengths) strengths.push('free');
        out[name] = {
            quality: round(quality, 1), coding: round(coding, 1), math: round(b?.math ?? null, 1),
            speed: round(speed, 0), ttft: round(b?.ttft ?? null, 2),
            inPrice, outPrice,
            // a 3:1 input-to-output blend, Artificial Analysis's convention
            blended: inPrice === null || outPrice === null ? null : round((3 * inPrice + outPrice) / 4, 4),
            strengths,
            qualityFrom,
            benchmark: b ? { slug: b.slug, name: b.name } : null,
            edited: !!saved[name],
            upstream: info.upstream || null,
        };
    }
    return out;
}

load();

module.exports = { fromArtificialAnalysis, matchKey, findBenchmark, forCatalog, derivedStrengths, build, set, load, STRENGTHS, AA_URL, FILE };
