#!/usr/bin/env node
/**
 * start-all — `npm run all`: Gateway, Router, Interceptor and task runner in one window
 *
 * Runs the three parts from the repo's .venv, so no Activate.ps1 is needed.
 * Ollama is opt-in: `npm run all:ollama`, `npm run all -- --ollama`, or
 * START_OLLAMA=1 in .env. It is skipped when Ollama already answers (the
 * Windows/macOS app runs it in the background).
 *
 * Ctrl+C stops everything.
 */

const fs   = require('fs');
const path = require('path');
const langfuse = require('../utils/langfuse');

const ROOT = path.resolve(__dirname, '..');

function venvBin(platform) {
    return platform === 'win32' ? path.join('.venv', 'Scripts') : path.join('.venv', 'bin');
}

/** Path of a .venv executable relative to the repo root, or the bare name when it isn't there. */
function venvTool(name, { platform = process.platform, exists = p => fs.existsSync(path.join(ROOT, p)) } = {}) {
    const file = path.join(venvBin(platform), platform === 'win32' ? `${name}.exe` : name);
    return exists(file) ? file : null;
}

function wantsOllama(argv, env) {
    if (argv.includes('--no-ollama')) return false;
    if (argv.includes('--ollama')) return true;
    return /^(1|true|yes|on)$/i.test(String(env.START_OLLAMA || '').trim());
}

/**
 * The commands to run. Returns { commands, warnings }.
 * opts: platform, env, argv, exists (relative path -> bool), ollamaRunning (bool)
 */
function buildCommands(opts = {}) {
    const platform = opts.platform || process.platform;
    const env      = opts.env || process.env;
    const argv     = opts.argv || [];
    const exists   = opts.exists;
    const warnings = [];

    const litellm = venvTool('litellm', { platform, exists });
    const python  = venvTool('python', { platform, exists });
    if (!litellm || !python) {
        warnings.push(`No .venv with LiteLLM found (looked in ${venvBin(platform)}). Using litellm and python from PATH. `
            + 'If the Gateway or Router fails with "not found", run the one-time setup in the README.');
    }

    // With Langfuse keys in .env the Gateway starts through docker/gateway-start.py,
    // which writes .gateway-config.yaml (config.yaml plus the Langfuse callbacks).
    const gateway = langfuse.configured(env)
        ? { command: `${python || 'python'} ${path.join('docker', 'gateway-start.py')}`,
            env: { PYTHONUTF8: '1', GATEWAY_SOURCE: 'config.yaml', GATEWAY_TARGET: '.gateway-config.yaml',
                   GATEWAY_LITELLM: litellm || 'litellm' } }
        : { command: `${litellm || 'litellm'} --config config.yaml`, env: { PYTHONUTF8: '1' } };
    const commands = [
        { name: 'gateway',     ...gateway, prefixColor: 'magenta' },
        { name: 'router',      command: `${python || 'python'} router.py`, env: { PYTHONUTF8: '1' }, prefixColor: 'cyan' },
        { name: 'interceptor', command: 'node server.js', prefixColor: 'green' },
        { name: 'runner',      command: 'node runner/server.js', prefixColor: 'blue' },
    ];

    // Federation: the Gateway calls OpenRouter through the Interceptor, which holds the short-lived tokens
    if ((env.OPENROUTER_FEDERATION_POLICY_ID && env.OPENROUTER_FEDERATION_POLICY_ID.trim()) || /^(1|true|yes|on)$/i.test(env.HARNESS_USER_CREDENTIALS || '')) {
        const key = env.OPENROUTER_PROXY_KEY || env.LITELLM_MASTER_KEY;
        const gateway = commands[0];
        gateway.env = {
            ...gateway.env,
            OPENROUTER_API_KEY: key,
            OPENROUTER_API_BASE: `${(env.OPENROUTER_PROXY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')}/openrouter-proxy/v1`,
        };
    }

    if (wantsOllama(argv, env)) {
        if (opts.ollamaRunning) warnings.push('Ollama is already running, so it is not started again.');
        else commands.push({ name: 'ollama', command: 'ollama serve', prefixColor: 'yellow' });
    }

    return { commands, warnings };
}

async function ollamaRunning(env) {
    const url = (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
    try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

async function main() {
    process.chdir(ROOT);
    require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

    const argv = process.argv.slice(2);
    // The Interceptor and the task runner share this, so nothing else on this machine can drive the runner
    if (!process.env.RUNNER_TOKEN) process.env.RUNNER_TOKEN = require('crypto').randomBytes(16).toString('hex');
    // Only the Interceptor, Gateway and Router know it
    if ((process.env.OPENROUTER_FEDERATION_POLICY_ID || /^(1|true|yes|on)$/i.test(process.env.HARNESS_USER_CREDENTIALS || '')) && !process.env.OPENROUTER_PROXY_KEY && !process.env.LITELLM_MASTER_KEY) {
        process.env.OPENROUTER_PROXY_KEY = require('crypto').randomBytes(16).toString('hex');
    }
    const running = wantsOllama(argv, process.env) && await ollamaRunning(process.env);
    const { commands, warnings } = buildCommands({ argv, ollamaRunning: running });
    for (const w of warnings) console.log(`[start-all] ${w}`);
    console.log(`[start-all] Starting ${commands.map(c => c.name).join(', ')}. Dashboard: http://localhost:3000/ui  (Ctrl+C stops all)`);

    const { concurrently } = await import('concurrently');
    const { result } = concurrently(commands, { cwd: ROOT, killOthersOn: [], prefix: 'name' });
    result.then(() => process.exit(0), () => process.exit(1));
}

if (require.main === module) {
    main().catch(err => {
        console.error(`[start-all] ${err.message}`);
        process.exit(1);
    });
}

module.exports = { buildCommands, wantsOllama, venvTool };
