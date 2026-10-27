'use strict';

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const MARKER = '__HARNESS_RESULT__';
const READY = '__HARNESS_READY__';
const sessions = new Set();
const SCRIPT = [
    "$ErrorActionPreference = 'Continue'",
    `Write-Output '${READY}'`,
    'while ($__hLine = [Console]::In.ReadLine()) {',
    '    $__hParts = $__hLine.Split(":", 2)',
    '    $__hId = $__hParts[0]',
    '    try {',
    '        $__hCommand = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__hParts[1]))',
    '        $global:LASTEXITCODE = 0',
    '        $__hResult = & ([scriptblock]::Create($__hCommand)) *>&1 | Out-String -Width 4096',
    '        $__hCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }',
    '    } catch {',
    '        $__hResult = ($_ | Out-String)',
    '        $__hCode = 1',
    '    }',
    '    $__hJson = ConvertTo-Json -Compress @{ code = $__hCode; output = [string]$__hResult }',
    `    Write-Output ('${MARKER}' + $__hId + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__hJson)))`,
    '}',
].join('; ');

const quotePowerShell = (text) => `'${String(text).replace(/'/g, "''")}'`;

function killTree(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.unref();
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
}

function killAndWait(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            child.kill();
            resolve();
        }, 5000);
        child.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
        killTree(child);
    });
}

function unref(child) {
    child?.unref();
    child?.stdin?.unref();
    child?.stdout?.unref();
    child?.stderr?.unref();
}

function ref(child) {
    child?.ref();
    child?.stdin?.ref();
    child?.stdout?.ref();
    child?.stderr?.ref();
}

class PowerShellSession {
    constructor(cwd, env) {
        this.cwd = cwd;
        this.env = env;
        this.child = null;
        this.children = new Set();
        this.pending = new Map();
        this.queue = Promise.resolve();
        this.busy = 0;
        this.ready = Promise.resolve();
        sessions.add(this);
    }

    run(command, timeoutMs) {
        if (this.closed) return Promise.resolve({ code: -1, output: 'PowerShell session is closed', timedOut: false, ms: 0 });
        const run = this.queue.then(() => this.runOne(command, timeoutMs));
        this.busy++;
        this.queue = run.then(() => { this.busy--; }, () => { this.busy--; });
        return run;
    }

    runOne(command, timeoutMs) {
        const started = Date.now();
        if (this.closed) return Promise.resolve({ code: -1, output: 'PowerShell session is closed', timedOut: false, ms: Date.now() - started });
        const child = this.start();
        return this.ready.then(() => this.runReady(child, command, timeoutMs, started), (err) => ({
            code: -1, output: `could not start PowerShell: ${err.message}`, timedOut: false, ms: Date.now() - started,
        }));
    }

    runReady(child, command, timeoutMs, started) {
        const id = randomUUID().replace(/-/g, '');
        const fullCommand = `Set-Location -LiteralPath ${quotePowerShell(this.cwd)}; ${command}`;
        const encoded = Buffer.from(fullCommand, 'utf8').toString('base64');

        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.pending.delete(id);
                if (!this.pending.size) unref(child);
                resolve({ ...result, ms: Date.now() - started });
            };
            const timer = setTimeout(() => {
                finish({ code: -1, output: 'PowerShell command timed out', timedOut: true });
                killTree(child);
                if (this.child === child) this.child = null;
            }, timeoutMs);
            this.pending.set(id, {
                child,
                finish(line) {
                    try {
                        const result = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
                        finish({ code: Number(result.code) || 0, output: String(result.output || ''), timedOut: false });
                    } catch (err) {
                        finish({ code: -1, output: `could not read PowerShell result: ${err.message}`, timedOut: false });
                    }
                },
            });
            ref(child);
            child.stdin.write(`${id}:${encoded}\n`, (err) => {
                if (err) finish({ code: -1, output: `could not send command to PowerShell: ${err.message}`, timedOut: false });
            });
        });
    }

    start() {
        if (this.child && !this.child.killed) {
            return this.child;
        }
        const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
            cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        this.child = child;
        this.children.add(child);
        let buffer = '';
        let stderr = '';
        let resolveReady, rejectReady;
        let isReady = false;
        this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, at).replace(/\r$/, '');
                buffer = buffer.slice(at + 1);
                if (line === READY) {
                    isReady = true;
                    resolveReady();
                    if (this.pending.size) ref(child);
                    else unref(child);
                    continue;
                }
                if (!line.startsWith(MARKER)) continue;
                const separator = line.indexOf(':', MARKER.length);
                if (separator < 0) continue;
                this.pending.get(line.slice(MARKER.length, separator))?.finish(line.slice(separator + 1));
            }
        });
        child.on('error', (err) => {
            const current = this.child === child;
            if (current) this.child = null;
            if (!isReady) rejectReady(err);
            const failed = Buffer.from(JSON.stringify({ code: -1, output: `could not start PowerShell: ${err.message}` })).toString('base64');
            for (const pending of this.pending.values()) if (pending.child === child) pending.finish(failed);
        });
        child.on('close', (code) => {
            this.children.delete(child);
            const current = this.child === child;
            if (current) this.child = null;
            if (!isReady) rejectReady(new Error(`PowerShell exited with code ${code ?? -1} before it was ready${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
            const closed = Buffer.from(JSON.stringify({ code: code ?? -1, output: '' })).toString('base64');
            for (const pending of this.pending.values()) {
                if (pending.child === child) pending.finish(closed);
            }
        });
        return child;
    }

    close() {
        this.closed = true;
        this.child = null;
        sessions.delete(this);
        return Promise.all([...this.children].map(killAndWait));
    }
}

function closeAll() {
    return Promise.all([...sessions].map(session => session.close()));
}

process.once('exit', closeAll);

module.exports = { PowerShellSession, closeAll };
