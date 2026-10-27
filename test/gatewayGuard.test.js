// A broken connection to the Gateway must read like one, not like "read
// ECONNRESET": a reset is the Gateway dropping the call, so it is a 502.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isReset, answerProxyError, KINDS } = require('../utils/gatewayGuard');

const fakeRes = () => {
    const res = {
        headersSent: false,
        writableEnded: false,
        status: null,
        body: null,
        writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
        end(body) { this.body = body; this.writableEnded = true; },
    };
    return res;
};

test('a reset or a dropped pipe counts as the Gateway dropping the call', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ECONNABORTED']) {
        assert.equal(isReset({ code }), true, code);
    }
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', '', undefined]) {
        assert.equal(isReset({ code }), false, String(code));
    }
});

test('a reset answers 502 "dropped the connection" instead of 504 "call failed"', () => {
    const res = fakeRes();
    const { kind, message } = answerProxyError({ code: 'ECONNRESET', message: 'read ECONNRESET' }, { url: '/v1/chat/completions' }, res);
    assert.equal(kind, KINDS.gatewayDown);
    assert.equal(res.status, 502);
    assert.match(message, /dropped the connection \(ECONNRESET\)/);
    assert.match(JSON.parse(res.body).error.message, /^\[harness: gateway down\] the Gateway \(LiteLLM\) dropped the connection/);
});

test('a refused connection still says the Gateway is not running', () => {
    const res = fakeRes();
    const { kind, message } = answerProxyError({ code: 'ECONNREFUSED' }, { url: '/v1/chat/completions' }, res);
    assert.equal(kind, KINDS.gatewayDown);
    assert.equal(res.status, 502);
    assert.match(message, /is not answering \(ECONNREFUSED\); is it running\?/);
});

test('any other failure keeps its own words, as a 504', () => {
    const res = fakeRes();
    const { kind, message } = answerProxyError({ code: 'ERR_STREAM_PREMATURE_CLOSE', message: 'stream closed' }, { url: '/v1/messages' }, res);
    assert.equal(kind, KINDS.upstream);
    assert.equal(res.status, 504);
    assert.match(message, /the Gateway call failed: stream closed/);
    assert.equal(JSON.parse(res.body).error.type, 'overloaded_error');
});
