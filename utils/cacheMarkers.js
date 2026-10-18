// Prompt cache markers for OpenAI-format requests going to Claude.
// Anthropic only caches a prompt up to a cache_control marker, and OpenAI-style
// clients (the chat page) send none, so their Claude chats are never cached.
// A client opts in with the x-harness-cache header; the markers are added only
// when the request was routed to an Anthropic model, since OpenAI, Groq and
// the rest cache by themselves and may reject the field.

// The Gateway's provider model is Claude (direct, OpenRouter, Bedrock, Vertex)
// and not a local engine that answers under a Claude name
function isAnthropic(info) {
    return !!info && !info.local && /(^|\/)anthropic\/|claude/.test(String(info.upstream || '').toLowerCase());
}

const hasText = (content) => (typeof content === 'string' ? content.trim() !== ''
    : Array.isArray(content) && content.some(p => p?.type === 'text' && p.text));

function marked(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    const parts = content.map(p => ({ ...p }));
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === 'text' && parts[i].text) { parts[i].cache_control = { type: 'ephemeral' }; break; }
    }
    return parts;
}

// Markers on the last system message and the last two user or assistant
// messages with text: the whole conversation so far is written to the cache,
// and the next request (one message longer) reads it back. Three of
// Anthropic's four allowed markers; a request that already has any is left alone.
function addCacheMarkers(messages) {
    if (!Array.isArray(messages) || messages.some(m => Array.isArray(m?.content) && m.content.some(p => p?.cache_control))) return messages;
    const at = new Set();
    for (let i = messages.length - 1, n = 0; i >= 0 && n < 2; i--) {
        const m = messages[i];
        if ((m.role === 'user' || m.role === 'assistant') && hasText(m.content)) { at.add(i); n++; }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'system' && hasText(messages[i].content)) { at.add(i); break; }
    }
    return messages.map((m, i) => (at.has(i) ? { ...m, content: marked(m.content) } : m));
}

module.exports = { isAnthropic, addCacheMarkers };
