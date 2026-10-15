// Keeps a request from hanging on the Gateway (LiteLLM) and says why one
// failed. A stuck provider used to leave the client waiting forever: the
// Gateway's own per-call timeout is 100 minutes, and a down Gateway got no
// answer at all. Errors go back in the shape the client's API expects
// (Anthropic for /v1/messages, OpenAI otherwise) so Claude Code and the chat
// page show the message instead of a dropped connection.

// What went wrong, in words the routing log shows as a tag
const KINDS = {
    rateLimit: 'rate limit',  // 429, or a provider quota message (free tiers)
    timeout: 'timeout',       // no answer, or a reply that stopped mid-stream
    gatewayDown: 'gateway down',
    upstream: 'error',        // any other failure the Gateway reported
    cancelled: 'stopped',     // the client went away (Stop button, Ctrl+C)
};

const RATE_LIMIT_TEXT = /rate.?limit|quota|too many requests|free-models-per-(day|min)|requests per (day|minute)|tokens per minute|\bTPM\b|\bRPM\b|exceeded/i;

// The Gateway's error body is JSON with the provider's message somewhere inside
function errorMessage(text) {
    try {
        const body = JSON.parse(text);
        const e = body.error ?? body.detail ?? body;
        const msg = typeof e === 'string' ? e : e.message ?? e.error ?? JSON.stringify(e);
        return String(msg).replace(/\s+/g, ' ').trim();
    } catch {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }
}

/** A failed Gateway answer as { kind, message }; message is cut to fit the log. */
function classify(status, text) {
    const message = errorMessage(text).slice(0, 500) || `HTTP ${status}`;
    const kind = status === 429 || RATE_LIMIT_TEXT.test(message) ? KINDS.rateLimit
        : status === 408 || status === 504 || /timed? ?out|timeout/i.test(message) ? KINDS.timeout
        : KINDS.upstream;
    return { kind, message };
}

const anthropicApi = (path) => /\/v1\/messages/.test(path || '');

// Error body for a request that never reached a model
function errorBody(path, status, kind, message) {
    if (anthropicApi(path)) {
        const type = status === 429 ? 'rate_limit_error' : status === 504 || status === 529 ? 'overloaded_error' : 'api_error';
        return { type: 'error', error: { type, message: `[harness: ${kind}] ${message}` } };
    }
    return { error: { message: `[harness: ${kind}] ${message}`, type: kind.replace(/ /g, '_'), code: status } };
}

// The same error as the last event of a reply that is already streaming
function streamError(path, kind, message) {
    const body = errorBody(path, 504, kind, message);
    return anthropicApi(path) ? `event: error\ndata: ${JSON.stringify(body)}\n\n` : `data: ${JSON.stringify(body)}\n\n`;
}

/**
 * Watch one proxied request. Fails it when the Gateway sends no response
 * headers within firstByteMs (that wait covers its whole fallback chain), or
 * when a reply goes quiet for idleMs. `onFail({ kind, message, status })`
 * records it; the guard answers the client and drops the upstream call.
 */
function guard({ req, res, proxyReq, firstByteMs, idleMs, onFail }) {
    let timer = null;
    let streaming = false;
    const clear = () => { clearTimeout(timer); timer = null; };
    const fail = (message) => {
        clear();
        if (req.harnessFailed || res.writableEnded) return;
        req.harnessFailed = true;
        onFail?.({ kind: KINDS.timeout, message, status: 504 });
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json(errorBody(req.originalUrl || req.path, 504, KINDS.timeout, message));
        } else {
            if (/event-stream/.test(String(res.getHeader('content-type') || ''))) {
                res.write(streamError(req.originalUrl || req.path, KINDS.timeout, message));
            }
            res.end();
        }
    };
    const arm = (ms, message) => {
        clear();
        if (ms > 0) timer = setTimeout(() => fail(message), ms);
    };
    const seconds = (ms) => Math.round(ms / 1000);

    arm(firstByteMs, `no answer from the Gateway in ${seconds(firstByteMs)} s; every model in the fallback chain was busy, rate-limited or hung`);
    res.on('close', clear);
    return {
        // The Gateway answered: from here only silence counts
        response(proxyRes) {
            streaming = true;
            const quiet = `the reply stopped for ${seconds(idleMs)} s mid-stream`;
            arm(idleMs, quiet);
            proxyRes.on('data', () => { if (timer) arm(idleMs, quiet); });
            proxyRes.on('end', clear);
            proxyRes.on('close', clear);
        },
        get streaming() { return streaming; },
        clear,
    };
}

/** Gateway unreachable or the call broke: answer the client if nothing was sent yet. */
function answerProxyError(err, req, res) {
    const code = err?.code || '';
    const down = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH/.test(code);
    const kind = down ? KINDS.gatewayDown : KINDS.upstream;
    const message = down
        ? `the Gateway (LiteLLM) is not answering (${code}); is it running?`
        : `the Gateway call failed: ${err?.message || code || 'unknown error'}`;
    if (res && typeof res.writeHead === 'function' && !res.writableEnded) {
        if (!res.headersSent) {
            res.writeHead(down ? 502 : 504, { 'content-type': 'application/json' });
            res.end(JSON.stringify(errorBody(req?.originalUrl || req?.url, down ? 502 : 504, kind, message)));
        } else {
            res.end();
        }
    } else if (res && typeof res.destroy === 'function') {
        res.destroy(); // a socket (websocket upgrade)
    }
    return { kind, message };
}

module.exports = { KINDS, classify, errorMessage, errorBody, streamError, guard, answerProxyError };
