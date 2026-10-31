// Headroom's MCP server (https://github.com/headroomlabs-ai/headroom, PyPI headroom-ai) for agent runs.
// Long tool outputs (a test log, a grep, a JSON dump) are sent to its headroom_compress tool, which keeps the
// lines that matter and stores the original under a hash. The model gets the shorter text and can call
// headroom_retrieve with the hash for the full one. Compression runs on this machine; nothing is sent to a model.
//
// Fails open: when the server cannot start or a call fails, the run gets its output as it was and the reason is
// recorded on the run. The Python program is started once per runner, on the first long output, and kept.
'use strict';

const fs = require('fs');
const path = require('path');
const { McpManager, toolName } = require('../utils/mcp');

const ROOT = path.join(__dirname, '..');
const MIN_CHARS = 4000;          // shorter outputs cost little and are left whole
const CALL_TIMEOUT_MS = 20000;   // compression is milliseconds; a longer wait means something is wrong
const RETRY_AFTER_MS = 5 * 60 * 1000; // after a failed start, try again this long later
const MAX_INPUT_CHARS = 400000;  // a longer output is left whole: Headroom is for what a model would read in full

/** The headroom program: HEADROOM_COMMAND, else the repo's .venv, else whatever is on PATH. */
function headroomCommand() {
    if (process.env.HEADROOM_COMMAND) return process.env.HEADROOM_COMMAND;
    const local = process.platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'headroom.exe') : path.join(ROOT, '.venv', 'bin', 'headroom');
    return fs.existsSync(local) ? local : 'headroom';
}

class Headroom {
    constructor({ command = headroomCommand(), args = ['mcp', 'serve'], minChars = MIN_CHARS } = {}) {
        this.command = command;
        this.args = args;
        this.minChars = minChars;
        this.manager = null;
        this.failedAt = 0;
        this.error = null;   // why it is not running, shown on the run
        this.ready = null;   // promise of the start, shared by every caller
    }

    /** Starts the server once. Resolves true when it is ready to be called. */
    start() {
        if (!this.ready || (this.failedAt && Date.now() - this.failedAt > RETRY_AFTER_MS)) {
            this.failedAt = 0;
            this.ready = this.connect();
        }
        return this.ready;
    }

    async connect() {
        const spec = { command: this.command, args: this.args, callTimeoutMs: CALL_TIMEOUT_MS, connectTimeoutMs: 60000 };
        // its reply is the whole record, original excluded, so the manager's usual cut must not apply
        const manager = new McpManager({ file: '', specs: async () => ({ headroom: spec }), plain: true, maxResultChars: Infinity });
        try {
            await manager.start();
            const server = manager.status().servers.find(s => s.name === 'headroom');
            if (!server || server.status !== 'connected') throw new Error(server?.error || 'the server did not start');
            this.manager = manager;
            this.error = null;
            return true;
        } catch (err) {
            await manager.close().catch(() => {});
            this.error = `Headroom did not start (${err.message}). Install it in the repo's .venv: pip install "headroom-ai[mcp]"`;
            this.failedAt = Date.now();
            return false;
        }
    }

    // The tool's name as the manager exposes it: mcp__headroom__headroom_compress
    async call(tool, args) {
        if (!(await this.start())) return null;
        const r = await this.manager.call(toolName('headroom', tool, new Set()), args);
        if (r.isError) throw new Error(r.text || `${tool} failed`);
        return r.text;
    }

    /**
     * A compressed copy of `text`, or null when it is short, nothing would be saved, or Headroom is not running.
     * Resolves { text, hash, originalTokens, compressedTokens, saved } on success.
     */
    async compress(text) {
        if (typeof text !== 'string' || text.length < this.minChars || text.length > MAX_INPUT_CHARS) return null;
        let raw;
        try {
            raw = await this.call('headroom_compress', { content: text });
        } catch (err) {
            this.error = `Headroom failed on one output (${err.message}); that output was kept whole`;
            return null;
        }
        if (raw === null) return null; // not running: this.error says why
        let out;
        try {
            out = JSON.parse(raw);
        } catch {
            this.error = 'Headroom answered with something other than its compression record; that output was kept whole';
            return null;
        }
        const saved = Number(out.tokens_saved) || 0;
        if (saved <= 0 || typeof out.compressed !== 'string' || out.compressed.length >= text.length) return null;
        return { text: out.compressed, hash: out.hash, originalTokens: out.original_tokens, compressedTokens: out.compressed_tokens, saved };
    }

    /** The full text behind a hash from compress(). Throws when it is gone or Headroom is down. */
    async retrieve(hash) {
        const text = await this.call('headroom_retrieve', { hash: String(hash) });
        if (text === null) throw new Error(this.error || 'Headroom is not running');
        // the server answers with a JSON record; the original is its original_content
        try {
            const original = JSON.parse(text).original_content;
            if (typeof original === 'string') return original;
        } catch { /* not JSON: already the text */ }
        return text;
    }

    async close() {
        const manager = this.manager;
        this.manager = null;
        this.ready = null;
        if (manager) await manager.close().catch(() => {});
    }
}

module.exports = { Headroom, headroomCommand, MIN_CHARS };
