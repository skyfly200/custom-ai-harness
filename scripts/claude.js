#!/usr/bin/env node
/**
 * claude — `npm run claude`: start Claude Code pointed at this harness
 *
 * Sets the variables from the README's "Connect Claude Code" section so
 * requests go through the Interceptor (http://localhost:3000) instead of
 * Anthropic. Everything else (model choice, compression, routing) is the harness.
 *
 *   ANTHROPIC_BASE_URL          the Interceptor's front door
 *   ANTHROPIC_AUTH_TOKEN        HARNESS_API_KEY, else HARNESS_PASSWORD, else a
 *                               placeholder the harness ignores
 *   CLAUDE_CODE_AUTO_MODE_SERVER 0 — don't ask Anthropic for the auto-mode config
 *   HARNESS_GUARD_URL           the command guard hook asks the same harness
 *
 * Extra arguments are passed through to Claude Code: `npm run claude -- -p "hi"`.
 * Set HARNESS_URL to use a harness on another machine (or behind a tunnel).
 * Set CLAUDE_CODE_BIN to use a Claude Code not named `claude` on PATH.
 * With HARNESS_REQUIRE_LOGIN=1, put an API key from the Users page in HARNESS_API_KEY.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The environment Claude Code needs, given the current one. */
function harnessEnv(base = process.env) {
    const url = (base.HARNESS_URL || 'http://localhost:3000').replace(/\/+$/, '');
    return {
        ...base,
        ANTHROPIC_BASE_URL: url,
        // A named-login API key, else the harness password, else a placeholder the harness ignores.
        ANTHROPIC_AUTH_TOKEN: base.HARNESS_API_KEY || base.HARNESS_PASSWORD || 'local-harness',
        CLAUDE_CODE_AUTO_MODE_SERVER: '0',
        // The command guard hook asks the same harness, wherever it is.
        ...(base.HARNESS_GUARD_URL ? {} : { HARNESS_GUARD_URL: `${url}/v1/guard` }),
    };
}

/** Whether the Interceptor answers. `/ui/api/status` is its always-on dashboard route. */
async function harnessUp(env) {
    try {
        // The status route sits behind HARNESS_PASSWORD / named logins like every other page.
        const headers = {};
        if (env.HARNESS_PASSWORD) headers['x-harness-password'] = env.HARNESS_PASSWORD;
        if (env.HARNESS_API_KEY) headers.authorization = `Bearer ${env.HARNESS_API_KEY}`;
        const res = await fetch(`${env.ANTHROPIC_BASE_URL}/ui/api/status`, { headers, signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

function claudeCommand(platform = process.platform, env = process.env) {
    if (env.CLAUDE_CODE_BIN) return env.CLAUDE_CODE_BIN;
    return platform === 'win32' ? 'claude.cmd' : 'claude';
}

async function main() {
    process.chdir(ROOT);
    require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

    const env = harnessEnv(process.env);
    if (!(await harnessUp(env))) {
        console.error(`[claude] Nothing is answering at ${env.ANTHROPIC_BASE_URL}.`);
        console.error('[claude] Start the harness first with `npm run all`, then run this again.');
        process.exit(1);
    }

    console.log(`[claude] Talking to the harness at ${env.ANTHROPIC_BASE_URL}`);
    const args = process.argv.slice(2);
    // shell on Windows: `claude` is a .cmd, which spawn can't run directly
    const child = spawn(claudeCommand(process.platform, process.env), args, {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
        if (err.code === 'ENOENT') {
            console.error(`[claude] Can't find "${claudeCommand()}" on PATH. Install Claude Code, or set CLAUDE_CODE_BIN to its path.`);
        } else {
            console.error(`[claude] ${err.message}`);
        }
        process.exit(1);
    });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[claude] ${err.message}`);
        process.exit(1);
    });
}

module.exports = { harnessEnv, harnessUp, claudeCommand };
