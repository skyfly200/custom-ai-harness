// Fly Sprites as a cloud sandbox: wraps the @fly/sprites client in the small shape
// the cloud sandbox in sandbox.js uses (the shape of e2b's Sandbox: sandboxId,
// files.{read,write,remove,makeDir,list}, commands.run, kill), so one class
// serves both providers. Needs SPRITES_TOKEN; @fly/sprites is an optional
// dependency (it needs Node 24) and is only loaded when a run asks for a Sprite.
'use strict';

const crypto = require('crypto');
const posix = require('path').posix;

let sdk = null;
let client = null;

/** Tests hand in a stand-in for @fly/sprites. */
function useSdk(mod) { sdk = mod; client = null; }

function getClient() {
    if (client) return client;
    if (!process.env.SPRITES_TOKEN) throw new Error('the sprites sandbox needs SPRITES_TOKEN in .env');
    if (!sdk) {
        try {
            sdk = require('@fly/sprites');
        } catch {
            throw new Error('the sprites sandbox needs the @fly/sprites package (Node 24 or newer): run npm install @fly/sprites');
        }
    }
    client = new sdk.SpritesClient(process.env.SPRITES_TOKEN, process.env.SPRITES_API_URL ? { baseURL: process.env.SPRITES_API_URL } : undefined);
    return client;
}

const toBuffer = (data) => (typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));

function named(name, message, extra = {}) {
    return Object.assign(new Error(message), { name }, extra);
}

/** A sprite, as the cloud sandbox sees it. */
function adapt(sprite, name) {
    const fs = sprite.filesystem('/');
    return {
        sandboxId: name,
        files: {
            async write(path, data) {
                await fs.mkdir(posix.dirname(path), { recursive: true });
                await fs.writeFile(path, toBuffer(data));
            },
            async read(path, { format } = {}) {
                return format === 'bytes' ? new Uint8Array(await fs.readFile(path, null)) : fs.readFile(path, 'utf8');
            },
            async remove(path) { await fs.rm(path, { recursive: true, force: true }); },
            async makeDir(path) { await fs.mkdir(path, { recursive: true }); },
            async list(path) {
                return (await fs.readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
            },
        },
        commands: {
            /** Starts `bash -c cmd`; resolves a handle { wait, kill } at once. wait() rejects with TimeoutError / CommandExitError like e2b's. */
            async run(cmd, { cwd, timeoutMs = 0, onStdout, onStderr } = {}) {
                const child = sprite.spawn('bash', ['-c', cmd], { cwd });
                let out = '';
                let err = '';
                let timedOut = false;
                child.stdout.on('data', (d) => { out += d; onStdout?.(String(d)); });
                child.stderr.on('data', (d) => { err += d; onStderr?.(String(d)); });
                const failed = new Promise((_, reject) => child.on('error', reject));
                failed.catch(() => {});
                const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } child.close?.(); }, timeoutMs) : null;
                return {
                    async wait() {
                        try {
                            const exitCode = await Promise.race([child.wait(), failed]);
                            if (timedOut) throw named('TimeoutError', `the command timed out after ${timeoutMs} ms`);
                            if (exitCode) throw named('CommandExitError', `exit ${exitCode}`, { exitCode, stdout: out, stderr: err });
                            return { exitCode: 0, stdout: out, stderr: err };
                        } finally {
                            clearTimeout(timer);
                        }
                    },
                    async kill() { try { child.kill('SIGKILL'); } catch { /* gone */ } },
                };
            },
        },
        async kill() { await getClient().deleteSprite(name); },
    };
}

/** A new, empty Sprite. It is deleted when the run ends, so nothing keeps billing. */
async function createSprite() {
    const name = `harness-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const sprite = await getClient().createSprite(name);
    return adapt(sprite, name);
}

async function deleteSprite(name) { await getClient().deleteSprite(name); }

module.exports = { createSprite, deleteSprite, useSdk };
