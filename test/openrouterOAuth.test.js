'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const oauth = require('../utils/openrouterOAuth');

const CALLBACK = 'https://agents.example.com/ui/api/me/credential/callback';
const stateOf = (url) => new URL(new URL(url).searchParams.get('callback_url')).searchParams.get('state');

test('begin sends the person to OpenRouter with an S256 challenge and a callback carrying our state', () => {
    const url = new URL(oauth.begin({ owner: 'amy', callback: CALLBACK }));
    assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const cb = new URL(url.searchParams.get('callback_url'));
    assert.equal(cb.origin + cb.pathname, CALLBACK);
    assert.ok(cb.searchParams.get('state'));
    const { verifier } = oauth._pending.get(cb.searchParams.get('state'));
    assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(verifier).digest('base64url'));
});

test('begin refuses a plain-http public address but allows localhost', () => {
    assert.throws(() => oauth.begin({ owner: 'amy', callback: 'http://agents.example.com/cb' }), /https/);
    assert.ok(oauth.begin({ owner: 'amy', callback: 'http://localhost:3000/cb' }));
    assert.throws(() => oauth.begin({ owner: '', callback: CALLBACK }), /signed in/);
});

test('finish trades the code and verifier for a key, once, for the same person only', async () => {
    const state = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK }));
    const { verifier } = oauth._pending.get(state);
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"key":"sk-or-v1-abcdefabcdefabcdef","user_id":"user_1"}'); };
    const got = await oauth.finish({ owner: 'amy', state, code: 'CODE1', fetchFn });
    assert.deepEqual(got, { key: 'sk-or-v1-abcdefabcdefabcdef', userId: 'user_1' });
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/auth/keys');
    assert.deepEqual(calls[0].body, { code: 'CODE1', code_verifier: verifier, code_challenge_method: 'S256' });
    await assert.rejects(oauth.finish({ owner: 'amy', state, code: 'CODE1', fetchFn }), /expired/); // single use

    const other = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK }));
    await assert.rejects(oauth.finish({ owner: 'bob', state: other, code: 'C', fetchFn }), /someone else/);
});

test('finish reports OpenRouter\'s refusal and expired links', async () => {
    const state = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK }));
    const refuse = async () => new Response('{"error":{"message":"bad verifier"}}', { status: 400 });
    await assert.rejects(oauth.finish({ owner: 'amy', state, code: 'C', fetchFn: refuse }), /bad verifier/);
    const late = stateOf(oauth.begin({ owner: 'amy', callback: CALLBACK }));
    await assert.rejects(oauth.finish({ owner: 'amy', state: late, code: 'C', now: () => Date.now() + 11 * 60 * 1000 }), /expired/);
    await assert.rejects(oauth.finish({ owner: 'amy', state: 'nope', code: 'C' }), /expired/);
});
