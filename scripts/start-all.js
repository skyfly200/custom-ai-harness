#!/usr/bin/env node
/**
 * start-all — `npm run all`: Gateway, Router and Interceptor in one window
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

    const commands = [
        { name: 'gateway',     command: `${litellm || 'litellm'} --config config.yaml`, env: { PYTHONUTF8: '1' }, prefixColor: 'magenta' },
        { name: 'router',      command: `${python || 'python'} router.py`, env: { PYTHONUTF8: '1' }, prefixColor: 'cyan' },
        { name: 'interceptor', command: 'node server.js', prefixColor: 'green' },
    ];

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
