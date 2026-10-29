// A model name as a person types it, matched to the newest model the Gateway
// serves: "opus" finds anthropic/claude-opus-5.5, "sonnet" the newest Sonnet,
// "haiku" the newest Haiku. A short name is the last part of a model's id
// without its version (or-claude-opus-5.5 -> claude-opus), and the newest one
// wins. A name the list already has is returned unchanged, so a full id (or a
// Gateway name like fast-openrouter) is never second-guessed.
//
// Numbers in an id are compared as version numbers, not as text: 5.10 is newer
// than 5.9, and a bare "5" is older than "5.1".

// Where a version starts in an id: the first "-4", "-5.5", "-3.1" and so on,
// not a year or a size ("gpt-4o" is the model, "llama-3.1-405b" its size)
const VERSION = /[-_](\d+(?:[._]\d+)*)/;

/** "anthropic/claude-opus-5.5:free" -> "claude-opus" */
function shortName(id) {
    const bare = String(id || '').trim().toLowerCase()
        .replace(/^or-/, '')
        .replace(/:free$/, '')
        .split('/')
        .pop();
    const at = bare.search(VERSION);
    const base = at > 0 ? bare.slice(0, at) : bare;
    return base.replace(/[-_]latest$/, '').replace(/[-_]+$/g, '');
}

/** [5, 10] for "5.10"; [] when there is no version at all */
function versionOf(id) {
    // "or-claude-opus-latest" is whatever is newest, so it outranks any number
    if (/[-_]latest(?::|$)/i.test(String(id || ''))) return [Infinity];
    const m = VERSION.exec(String(id || '').toLowerCase());
    return m ? m[1].split(/[._]/).map((n) => Number(n)) : [];
}

// a < b in version order, with missing parts counting as 0 (5 < 5.1, 5.5 < 5.10)
function olderThan(a, b) {
    const x = versionOf(a), y = versionOf(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const p = x[i] ?? 0, q = y[i] ?? 0;
        if (p !== q) return p < q;
    }
    return false;
}

// Names a person types for a family: Claude's three, and the bare vendor ones
const FAMILIES = {
    opus: ['claude-opus', 'claude-3-opus', 'opus'],
    sonnet: ['claude-sonnet', 'claude-3-sonnet', 'claude-3-5-sonnet', 'sonnet'],
    haiku: ['claude-haiku', 'claude-3-haiku', 'claude-3-5-haiku', 'haiku'],
};

/**
 * The models a short name could mean, newest first. `models` is the list the
 * Gateway serves (or config.yaml's names). An exact match is returned on its own.
 */
function candidates(name, models = []) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return [];
    const all = [...new Set(models.filter((m) => typeof m === 'string' && m.trim()))];
    const exact = all.find((m) => m.toLowerCase() === want)
        || all.find((m) => m.toLowerCase().replace(/^or-/, '') === want);
    if (exact) return [exact];
    // "opus-4.5" and "claude-opus-5.5" name a version; "opus" leaves it open
    const family = shortName(want);
    const shorts = FAMILIES[family] || [family];
    const hits = all.filter((m) => {
        const s = shortName(m);
        if (shorts.includes(s)) return true;
        // "claude-opus" also answers to "opus" when nothing is called just "opus"
        return shorts.some((f) => s === `claude-${f}` || s === f);
    });
    if (hits.length) return hits.sort(newestFirst);
    // not a family name: every word typed is somewhere in the id ("gpt mini")
    return search(want, all).filter((h) => h.score >= TOKENS).map((h) => h.id);
}

const newestFirst = (a, b) => (olderThan(a, b) ? 1 : olderThan(b, a) ? -1 : 0);

// Match scores, best first. A family name is checked before these in candidates().
const EXACT = 100, PREFIX = 80, TOKENS = 60, LOOSE = 20;

// every character of `needle` appears in `hay` in order ("cldop" in "claude-opus")
function subsequence(needle, hay) {
    let i = 0;
    for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
    return needle.length === 0;
}

/**
 * Models that fit what has been typed so far, best first, for a suggestion list.
 * Matches across the whole id (vendor, name, version), so "opus", "or-claude-opus",
 * "gpt mini" and "cldop" all find something. Equal fits list the newest first.
 * An empty query lists the models as given. Returns [{ id, score }].
 */
function search(query, models = [], limit = 0) {
    const want = String(query || '').trim().toLowerCase();
    const all = [...new Set(models.filter((m) => typeof m === 'string' && m.trim()))];
    if (!want) return (limit ? all.slice(0, limit) : all).map((id) => ({ id, score: 0 }));
    const words = want.split(/[\s/]+/).filter(Boolean);
    const out = [];
    for (const id of all) {
        const low = id.toLowerCase(), bare = low.replace(/^or-/, '');
        const parts = bare.split(/[^a-z0-9.]+/).filter(Boolean);
        let score = 0;
        if (low === want || bare === want) score = EXACT;
        else if (bare.startsWith(want) || bare.split('/').pop().startsWith(want) || parts.includes(want)) score = PREFIX;
        else if (words.every((w) => low.includes(w))) score = TOKENS;
        else if (subsequence(want.replace(/[\s/-]+/g, ''), low.replace(/[^a-z0-9.]/g, ''))) score = LOOSE;
        if (score) out.push({ id, score });
    }
    out.sort((a, b) => b.score - a.score || newestFirst(a.id, b.id) || a.id.length - b.id.length);
    return limit ? out.slice(0, limit) : out;
}

/**
 * The model a short name stands for: the newest one, or null when nothing fits.
 * A name with a version in it ("opus-4.5", "claude-opus-5.5") picks that version.
 */
function resolve(name, models = []) {
    const hits = candidates(name, models);
    if (!hits.length) return null;
    const want = String(name || '').trim().toLowerCase();
    if (!VERSION.test(want)) return hits[0];
    // a version that was asked for by name must be served: "opus-9" is not "the newest opus"
    const same = versionOf(want).join('.');
    return hits.find((m) => versionOf(m).join('.') === same) || null;
}

const api = { resolve, candidates, search, shortName, versionOf, olderThan, FAMILIES };
if (typeof module === 'object' && module.exports) module.exports = api;
else globalThis.ModelAlias = api;
