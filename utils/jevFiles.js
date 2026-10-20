// Reading a file for the ask_jev_file tools. The file's text goes to the
// harness (and on to Jev), never into the agent's context, so this refuses
// what shouldn't leave the machine: files outside the allowed folders
// (HARNESS_FILE_ROOTS, default the folder the tool server started in),
// secrets files, binaries and anything over HARNESS_FILE_MAX_BYTES (2 MB).

const fs = require('fs');
const path = require('path');
const guard = require('./guard');

const MAX_BYTES = () => Number(process.env.HARNESS_FILE_MAX_BYTES) || 2 * 1024 * 1024;
const SECRET_RULES = new Set(['env-file', 'ssh-keys', 'credentials']);

function roots() {
    const list = (process.env.HARNESS_FILE_ROOTS || '').split(path.delimiter).filter(Boolean);
    return (list.length ? list : [process.cwd()]).map((r) => {
        try { return fs.realpathSync(path.resolve(r)); } catch { return path.resolve(r); }
    });
}

function inside(file, root) {
    const rel = path.relative(root, file);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The file's text, or an Error saying why Jev can't be asked about it. */
function readFileText(file) {
    let real;
    try {
        real = fs.realpathSync(path.resolve(file));
    } catch {
        throw new Error(`${file} does not exist`);
    }
    if (!roots().some((r) => inside(real, r))) throw new Error(`${file} is outside the allowed folders (HARNESS_FILE_ROOTS)`);
    const rule = guard.matchRule('write', real);
    if (rule && SECRET_RULES.has(rule.id)) throw new Error(`${file} looks like a secrets file, so it is not sent to a model`);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error(`${file} is not a file`);
    if (stat.size > MAX_BYTES()) throw new Error(`${file} is ${stat.size} bytes, over the ${MAX_BYTES()} byte limit`);
    const buf = fs.readFileSync(real);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${file} is a binary file`);
    return buf.toString('utf8');
}

/** Ask the harness about one file. `post(body)` resolves to the /v1/jev/ask result. */
async function askFile(post, file, question, mode, extra = {}) {
    return post({ text: readFileText(file), question, mode, ...extra });
}

function percent(p) {
    return `${Math.round(p * 100)}%`;
}

function describe(file, r) {
    const where = r.score > 0.05 ? `, strongest around line ${r.best.line}` : '';
    const cut = r.truncated ? ` Only the first ${r.scanned} of ${r.windows} parts were read.` : '';
    if (r.mode === 'bool') return `${file}: ${r.answer ? 'yes' : 'no'} (Jev ${percent(r.score)} sure it is yes${where}).${cut}`;
    return `${file}: ${r.score.toFixed(2)} on a 0 to 1 scale${where}.${cut}`;
}

module.exports = { readFileText, askFile, describe, percent, roots };
