// The request transforms the Interceptor applies (server.js, around compressToolResults),
// for the serverless handler. Same order and same rules:
//   1. caveman: the terse-output line goes into the system prompt
//   2. context anchor: a repeated tool result becomes a pointer to the first copy
//   3. Headroom: long tool results are shortened (the in-repo middle truncation,
//      exactly as the Docker stack does it)
//   4. Headroom service (optional): the headroom-ai TypeScript client sends tool results
//      to a `headroom proxy` at HEADROOM_URL to compress them further. Unset, or unreachable,
//      the request goes on as it was after step 3 (the client falls back, it never fails the call).
// User text is never changed. Only tool messages are changed by steps 2-4.
import headroomTransforms from '../utils/messageTransforms.js';
import { HeadroomClient } from 'headroom-ai';

const T = headroomTransforms;

const flag = (value, fallback = true) => {
    if (value === undefined || value === '') return fallback;
    return !/^(0|false|off|no)$/i.test(String(value).trim());
};

/** Which transforms are on, from the environment (the serverless stand-in for the Settings page). */
export function readTransforms(env = {}) {
    return {
        caveman: flag(env.HARNESS_CAVEMAN),
        contextAnchor: flag(env.HARNESS_CONTEXT_ANCHOR),
        headroom: flag(env.HARNESS_HEADROOM),
        headroomUrl: String(env.HEADROOM_URL || '').replace(/\/+$/, ''),
        headroomTimeoutMs: Number(env.HEADROOM_TIMEOUT_MS) > 0 ? Number(env.HEADROOM_TIMEOUT_MS) : 5000,
    };
}

const isToolMessage = (m) => m && m.role === 'tool';

/**
 * Asks the headroom-ai client to compress the tool results of a chat. Only the content
 * of tool messages is taken from its answer; every other message stays as it was.
 * If the answer does not line up with the input, the input is kept.
 */
export async function compressWithHeadroom(messages, model, client) {
    let result;
    try {
        result = await client.compress(messages, { model });
    } catch {
        return { messages, applied: false };
    }
    const out = result && result.messages;
    if (!Array.isArray(out) || out.length !== messages.length || result.compressed === false) {
        return { messages, applied: false };
    }
    const merged = messages.map((orig, i) => (isToolMessage(orig) && out[i] && out[i].content !== undefined
        ? { ...orig, content: out[i].content }
        : orig));
    return { messages: merged, applied: true };
}

/**
 * Applies the transforms to a chat body. `headroomClient` is injectable for tests;
 * by default a headroom-ai client is made for HEADROOM_URL when it is set.
 * Returns the new body and the names of the transforms that changed something.
 */
export async function applyTransforms(body, tf, { headroomClient } = {}) {
    const applied = [];
    let messages = Array.isArray(body.messages) ? body.messages : [];

    if (tf.caveman) {
        messages = T.withCavemanOpenAI(messages);
        applied.push('caveman');
    }
    if (tf.contextAnchor) {
        const next = T.applyContextAnchor(messages);
        if (JSON.stringify(next) !== JSON.stringify(messages)) applied.push('context anchor');
        messages = next;
    }
    if (tf.headroom) {
        const next = T.applyHeadroom(messages);
        if (JSON.stringify(next) !== JSON.stringify(messages)) applied.push('headroom');
        messages = next;
    }
    if (tf.headroom && (headroomClient || tf.headroomUrl)) {
        const client = headroomClient || new HeadroomClient({ baseUrl: tf.headroomUrl, timeout: tf.headroomTimeoutMs, fallback: true, retries: 0 });
        const r = await compressWithHeadroom(messages, body.model, client);
        if (r.applied) {
            messages = r.messages;
            applied.push('headroom service');
        }
    }
    return { body: { ...body, messages }, applied };
}
