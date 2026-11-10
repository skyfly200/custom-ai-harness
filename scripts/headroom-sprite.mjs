#!/usr/bin/env node
// Runs the Headroom proxy as a Fly Sprite, for the serverless harness (docs/serverless.md).
//
//   node scripts/headroom-sprite.mjs setup    create the sprite, install headroom-ai, start the service
//   node scripts/headroom-sprite.mjs status   show the sprite's URL and whether the service is running
//   node scripts/headroom-sprite.mjs token    print a new random token (save it; setup needs the same one)
//
// Needs Node 24 (the @fly/sprites SDK), SPRITES_TOKEN, and HEADROOM_PROXY_TOKEN for setup (the same
// value goes to the host as HEADROOM_API_KEY). The sprite sleeps when idle and wakes on the next
// request to its URL; the Headroom service starts again with it.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SPRITE_NAME = process.env.HEADROOM_SPRITE_NAME || 'harness-headroom';
export const HEADROOM_VERSION = '0.42.0';
export const PORT = 8787;
const VENV = '/opt/headroom';

/** A new random token for the Headroom proxy. */
export function newToken() {
    return crypto.randomBytes(32).toString('hex');
}

/** The token setup uses: HEADROOM_PROXY_TOKEN, or none (setup then asks for one). */
export function tokenFrom(env = process.env) {
    const t = String(env.HEADROOM_PROXY_TOKEN || '').trim();
    if (t.length < 16) throw new Error('set HEADROOM_PROXY_TOKEN to a random string of at least 16 characters (node scripts/headroom-sprite.mjs token makes one)');
    return t;
}

/**
 * The service that runs the proxy. The token is set on the proxy itself, so /v1/* refuses
 * callers without it (the proxy allows a non-local bind only with a token). httpPort routes
 * the sprite's URL to it.
 */
export function serviceRequest(token) {
    return {
        cmd: `${VENV}/bin/headroom`,
        args: ['proxy', '--host', '0.0.0.0', '--port', String(PORT)],
        env: { HEADROOM_PROXY_TOKEN: token },
        httpPort: PORT,
    };
}

/** The lines to put in Netlify or Vercel once the sprite exists. */
export function hostEnv({ url, token }) {
    return [
        `HEADROOM_URL=${String(url).replace(/\/+$/, '')}`,
        `HEADROOM_API_KEY=${token}`,
        'HEADROOM_TIMEOUT_MS=8000',
    ].join('\n');
}

async function sdk() {
    try {
        return await import('@fly/sprites');
    } catch {
        throw new Error('the @fly/sprites package is needed (Node 24 or newer): npm install');
    }
}

async function client() {
    if (!process.env.SPRITES_TOKEN) throw new Error('set SPRITES_TOKEN (a Sprites access token from your Fly account)');
    const { SpritesClient } = await sdk();
    return new SpritesClient(process.env.SPRITES_TOKEN);
}

async function getOrCreate(c) {
    try {
        return await c.getSprite(SPRITE_NAME);
    } catch {
        console.log(`creating sprite ${SPRITE_NAME}`);
        // public: the proxy checks its own token, so the URL needs no Sprite login
        return await c.createSprite(SPRITE_NAME, { urlSettings: { auth: 'public' } });
    }
}

async function setup() {
    const token = tokenFrom();
    const c = await client();
    const info = await getOrCreate(c);
    const sprite = c.sprite(SPRITE_NAME);

    console.log(`installing headroom-ai[proxy]==${HEADROOM_VERSION} in ${VENV}`);
    await sprite.exec(`python3 -m venv ${VENV} && ${VENV}/bin/pip install -q "headroom-ai[proxy]==${HEADROOM_VERSION}"`);

    console.log('starting the headroom service');
    const stream = await sprite.createService('headroom', serviceRequest(token), '120s');
    await stream.processAll((ev) => {
        if (ev.type === 'stdout' || ev.type === 'stderr') process.stdout.write(`  ${ev.data || ''}`);
        else if (ev.type === 'error' || ev.type === 'exit') console.log(`  ${ev.type}${ev.exitCode !== undefined ? ` ${ev.exitCode}` : ''} ${ev.data || ''}`.trimEnd());
    });

    const url = info.url || (await c.getSprite(SPRITE_NAME)).url;
    console.log('\nSet these in Netlify or Vercel (environment variables):\n');
    console.log(hostEnv({ url, token }));
}

async function status() {
    const c = await client();
    const info = await c.getSprite(SPRITE_NAME);
    const services = await c.sprite(SPRITE_NAME).listServices().catch(() => []);
    console.log(`sprite ${SPRITE_NAME}: ${info.url}`);
    for (const s of services) console.log(`service ${s.name}: ${s.state?.status || 'unknown'}`);
}

async function main(argv) {
    const cmd = argv[0];
    if (cmd === 'setup') return setup();
    if (cmd === 'status') return status();
    if (cmd === 'token') { console.log(newToken()); return; }
    console.log('usage: node scripts/headroom-sprite.mjs setup | status | token');
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
}
