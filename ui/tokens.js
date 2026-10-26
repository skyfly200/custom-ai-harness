// Reading token counts out of what a provider reports, and estimating them when it
// reports nothing. The same answer in the page (window.Tokens) and in the
// Interceptor (require), so a number shown in a chat is the number the Usage
// page and the Dashboard count.
(function (root) {
  // What an OpenAI or Anthropic usage object says, in one shape. Only the fields
  // the provider really sent: a count it did not send is null, never 0, so the
  // caller can tell "nothing cached" from "it didn't say".
  //   input      all input tokens, cache reads and writes included
  //   output     generated tokens
  //   cacheRead  input read from the provider's prompt cache
  //   cacheWrite input written to it
  //   cost, reported by the provider (OpenRouter's usage.cost), else null
  //   exact      the provider counted the input itself
  function usage(u) {
    if (!u || typeof u !== 'object') return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const cacheRead = num(u.cache_read_input_tokens) ?? num(u.prompt_tokens_details?.cached_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens) ?? num(u.prompt_tokens_details?.cache_write_tokens);
    const prompt = num(u.prompt_tokens);
    const anthropic = num(u.input_tokens);
    const input = prompt ?? (anthropic == null && cacheRead == null && cacheWrite == null
      ? null
      : (anthropic || 0) + (cacheRead || 0) + (cacheWrite || 0));
    const output = num(u.completion_tokens) ?? num(u.output_tokens);
    if (input == null && output == null) return null;
    return {
      input: input || 0,
      output: output || 0,
      cacheRead: cacheRead || 0,
      cacheWrite: cacheWrite || 0,
      cost: num(u.cost),
      // OpenAI and Anthropic count prompt tokens themselves; an estimate is only
      // needed when nothing was counted at all
      exact: input != null,
    };
  }

  // Streams report usage in pieces (Anthropic: input at message_start, output at
  // message_delta) and counts only ever grow, so keep the largest of each.
  function merge(a, b) {
    if (!b) return a;
    if (!a) return b;
    return {
      input: Math.max(a.input, b.input),
      output: Math.max(a.output, b.output),
      cacheRead: Math.max(a.cacheRead, b.cacheRead),
      cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
      cost: b.cost ?? a.cost,
      exact: a.exact || b.exact,
    };
  }

  // Characters of text one streamed piece carried: the reply, its thinking and
  // any tool arguments. Used when the provider reports no counts at all.
  function charsOf(obj) {
    let n = 0;
    for (const choice of obj?.choices || []) {
      const m = choice.delta || choice.message || {};
      if (typeof m.content === 'string') n += m.content.length;
      if (typeof m.reasoning_content === 'string') n += m.reasoning_content.length;
      if (typeof m.reasoning === 'string') n += m.reasoning.length;
      for (const call of m.tool_calls || []) n += (call.function?.arguments || '').length;
    }
    const d = obj?.delta; // Anthropic content_block_delta
    if (d) n += (d.text || d.partial_json || d.thinking || '').length;
    for (const block of Array.isArray(obj?.content) ? obj.content : []) {
      n += (block.text || '').length + (block.input ? JSON.stringify(block.input).length : 0);
    }
    return n;
  }

  // A token estimate someone down the chain already made (the Interceptor sends
  // its own with every reply), marked inexact so the page can say "~"
  function fromEstimate(est) {
    if (!est) return null;
    const input = Math.max(0, Math.round(est.input || 0));
    const output = Math.max(0, Math.round(est.output || 0));
    if (!input && !output) return null;
    return { input, output, cacheRead: 0, cacheWrite: 0, cost: est.cost ?? null, exact: false };
  }

  // About 4 characters a token, the same rule the Interceptor uses for its
  // request size, so an estimate in a chat and one on the Dashboard agree
  function size(prompt) {
    if (!prompt || typeof prompt !== 'string') return 0;
    return Math.ceil(prompt.length / 4);
  }

  const api = { usage, merge, charsOf, fromEstimate, size };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Tokens = api;
})(typeof window !== 'undefined' ? window : globalThis);
