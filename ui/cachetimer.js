// How long a provider keeps a chat's prompt cache, and how much of it is left.
// Works in the page (window.CacheTimer) and in Node tests (require).
(function (root) {
  const MIN = 60 * 1000;

  // The provider rule for a model, from the Gateway's provider model name
  // (litellm_params.model, e.g. "openrouter/anthropic/claude-sonnet-5.5").
  //   ttl:     how long a cache lasts after its last use (ms), null when unknown
  //   minimum: true when the provider only promises at least that long
  //   markers: true when caching needs cache_control markers in the request
  // info.local is 'ollama' or 'engine' for models served from this machine.
  function cacheRule(info) {
    const up = String(info?.upstream || '').toLowerCase();
    const model = up.replace(/^openrouter\//, '');
    if (info?.local === 'ollama') {
      return { provider: 'Ollama', ttl: 5 * MIN, minimum: false, note: 'Ollama keeps the model and its cache loaded for 5 minutes after the last request (OLLAMA_KEEP_ALIVE).' };
    }
    if (info?.local) return { provider: 'This machine', ttl: null, note: 'A local engine: how long it keeps a prompt cache depends on the engine.' };
    if (/^(anthropic\/|bedrock\/.*anthropic|vertex_ai\/claude)|claude/.test(model)) {
      return { provider: 'Anthropic', ttl: 5 * MIN, ttlLong: 60 * MIN, minimum: false, markers: true,
        note: 'Anthropic keeps a cache 5 minutes (1 hour when asked for) and restarts the clock on every hit. Only requests with cache markers are cached.' };
    }
    if (/^(openai|azure)\//.test(model)) {
      return { provider: 'OpenAI', ttl: 5 * MIN, minimum: true, minTokens: 1024,
        note: 'OpenAI caches prompts of 1,024+ tokens by itself and keeps them 5 to 10 minutes after the last use, sometimes up to an hour.' };
    }
    return { provider: providerName(up), ttl: null, note: 'This provider does not publish how long its prompt cache lasts.' };
  }

  function providerName(up) {
    const parts = up.split('/');
    const p = parts[0] === 'openrouter' ? parts[1] : parts[0];
    return p ? p[0].toUpperCase() + p.slice(1) : 'Unknown';
  }

  // Cache facts from a reply's usage, in whichever shape the provider sent it
  function cacheUsage(u) {
    if (!u) return null;
    const read = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_write_tokens ?? 0;
    const long = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const prompt = u.prompt_tokens ?? ((u.input_tokens ?? 0) + read + write);
    return { read, write, long, prompt };
  }

  // Where one chat's cache with one model stands at `now`.
  // entry: { at, read, write, long, prompt } from the last request to that model.
  //   state: 'warm' | 'expired' | 'none' (nothing was cached) | 'unknown'
  function cacheState(entry, rule, now = Date.now()) {
    if (!entry) return { state: 'none' };
    const cachedSomething = entry.read > 0 || entry.write > 0;
    if (!rule || rule.ttl == null) return { state: 'unknown', cachedSomething };
    if (rule.markers && !cachedSomething) return { state: 'none', why: 'The provider reported nothing cached (no cache markers in the request, or the prompt is too short).' };
    if (rule.minTokens && !cachedSomething && (entry.prompt || 0) < rule.minTokens) {
      return { state: 'none', why: `The prompt was under ${rule.minTokens.toLocaleString()} tokens, too short to cache.` };
    }
    const ttl = entry.long > 0 && rule.ttlLong ? rule.ttlLong : rule.ttl;
    const left = entry.at + ttl - now;
    return { state: left > 0 ? 'warm' : 'expired', left: Math.max(0, left), ttl, expires: entry.at + ttl, minimum: !!rule.minimum };
  }

  const fmtLeft = (ms) => {
    const s = Math.ceil(ms / 1000);
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const api = { cacheRule, cacheUsage, cacheState, fmtLeft };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CacheTimer = api;
})(typeof window !== 'undefined' ? window : globalThis);
