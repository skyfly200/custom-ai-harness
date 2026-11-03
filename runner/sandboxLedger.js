// A ledger of what the task runner's compute costs: one span per cloud sandbox (an E2B sandbox or a Fly Sprite, from
// the moment it opens until it is killed) and one span per Fly Machine stretch seen running (runner/flyMachines.js).
// Only times and ids are kept, never code or output. The admin page reads it through runner/sandboxCosts.js.
//
// The file is written on every change (small: one entry per sandbox). A sandbox still open when the runner restarts
// is closed at load time and marked `recovered`, because nothing can say when it really ended.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 20000;

class SandboxLedger {
    constructor({ file = '', now = () => Date.now() } = {}) {
        this.file = file;
        this.now = now;
        this.entries = [];
        this.open = new Map(); // "driver:id" -> the open sandbox span
        this.machineSpan = new Map(); // machine id -> its latest span, extended while the machine stays up
        this.load();
    }

    load() {
        if (!this.file) return;
        try {
            if (fs.existsSync(this.file)) this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')).entries || [];
        } catch {
            this.entries = []; // a damaged file starts a new ledger; the old one is kept beside it
            try { fs.renameSync(this.file, `${this.file}.broken`); } catch { /* nothing to keep */ }
        }
        const at = this.now();
        for (const e of this.entries) {
            if (e.kind === 'sandbox' && e.end == null) { e.end = at; e.recovered = true; }
        }
        for (const e of this.entries) {
            if (e.kind === 'sandbox') continue;
            if (e.kind === 'machine') this.machineSpan.set(e.id, e);
        }
        this.save();
    }

    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }));
            fs.renameSync(tmp, this.file);
        } catch { /* the ledger is a record, not a run: a full disk must not stop a run */ }
    }

    trim() {
        if (this.entries.length <= MAX_ENTRIES) return;
        const extra = this.entries.length - MAX_ENTRIES;
        const dropped = this.entries.splice(0, extra).filter((e) => e.end != null);
        for (const e of dropped) if (e.kind === 'machine' && this.machineSpan.get(e.id) === e) this.machineSpan.delete(e.id);
    }

    /** A cloud sandbox opened. `cpus` and `memMb` are optional: without them the rates' defaults apply. */
    begin({ driver, id, runId = '', owner = '', cpus, memMb }) {
        const key = `${driver}:${id}`;
        if (this.open.has(key)) return this.open.get(key);
        const span = { kind: 'sandbox', driver, id: String(id), runId: String(runId || ''), owner: String(owner || ''), start: this.now(), end: null };
        if (cpus) span.cpus = Number(cpus);
        if (memMb) span.memMb = Number(memMb);
        this.open.set(key, span);
        this.entries.push(span);
        this.trim();
        this.save();
        return span;
    }

    /** The sandbox was killed (or is known to be gone). Closing one that is not open does nothing. */
    end(driver, id) {
        const key = `${driver}:${id}`;
        const span = this.open.get(key);
        if (!span) return;
        span.end = this.now();
        this.open.delete(key);
        this.save();
    }

    /**
     * A Fly Machine seen running over [start, end]. Samples that touch the machine's latest span extend it, so a machine
     * that stays up is one span however many samples it took.
     */
    sample({ id, name = '', size, cpus, memMb, start, end }) {
        const last = this.machineSpan.get(id);
        if (last && last.end === start) {
            last.end = end;
        } else {
            const span = { kind: 'machine', driver: 'fly-machine', id: String(id), name: String(name || id), size: String(size || ''), cpus: Number(cpus) || 1, memMb: Number(memMb) || 256, owner: '', start, end };
            this.machineSpan.set(id, span);
            this.entries.push(span);
            this.trim();
        }
        this.save();
    }
}

// The runner's ledger: the runner server replaces it with one that has a file (configure); tests use an in-memory one.
let current = new SandboxLedger();
const ledger = () => current;
function configureLedger(opts) {
    current = new SandboxLedger(opts);
    return current;
}

module.exports = { SandboxLedger, ledger, configureLedger, MAX_ENTRIES };
