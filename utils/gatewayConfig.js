// The Gateway's (LiteLLM's) config.yaml, as the routing editor sees it: the
// models it serves (model_list) and their fallback chains. Edits are made line
// by line: whole model_list entries are removed or appended and fallback lines
// rewritten, so comments and the rest of the file stay put. LiteLLM reads the
// file at start, so a change needs a Gateway restart.

const crypto = require('crypto');

const NAME = /^[\w.:/@-]+$/;
const MODEL_ID = /^[\w.:/@+-]+$/;
const API_BASE = /^https?:\/\/[^\s"'#]+$/;
const API_KEY = /^(os\.environ\/[A-Za-z_][A-Za-z0-9_]*|[\w.-]+)$/;

/** A hash of the file, so a save can tell it was changed since the page read it. */
const version = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

function modelNames(text) {
    return [...new Set([...text.matchAll(/^\s*-\s*model_name:\s*["']?([^"'\s#]+)/gm)].map(m => m[1]))];
}

// One flow-style item, e.g. {"local-engine": ["a", "b"]}; bare names are quoted first.
function parseItem(flow) {
    const json = flow.replace(/#.*$/, '').trim().replace(/([{[,]\s*)([\w.:/@-]+)(?=\s*[:,\]}])/g, '$1"$2"');
    const value = JSON.parse(json);
    const entries = Object.entries(value);
    if (entries.length !== 1 || !Array.isArray(entries[0][1]) || !entries[0][1].every(t => typeof t === 'string')) {
        throw new Error('not one model with a list');
    }
    return entries[0];
}

/** Where the fallbacks block sits: {start, end, indent, items: [{line, source, targets}]}, or null if there is none. */
function findBlock(lines) {
    const top = lines.findIndex(l => /^litellm_settings:\s*(#.*)?$/.test(l));
    if (top < 0) return null;
    for (let i = top + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
        const m = lines[i].match(/^(\s+)fallbacks:\s*(.*?)\s*$/);
        if (!m) continue;
        if (m[2] && !m[2].startsWith('#')) throw new Error('fallbacks is written on one line; put each chain on its own "- {...}" line to edit it here');
        const indent = m[1].length;
        const items = [];
        let end = i + 1;
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment
            const lead = line.match(/^\s*/)[0].length;
            if (lead <= indent && !/^\s*-/.test(line)) break;
            if (lead < indent) break;
            const item = line.match(/^\s*-\s*(\{.*\})\s*(#.*)?$/);
            if (!item) throw new Error(`can't read fallbacks line ${j + 1}: ${line.trim()}`);
            let entry;
            try { entry = parseItem(item[1]); } catch (err) { throw new Error(`can't read fallbacks line ${j + 1} (${err.message})`); }
            items.push({ line: j, source: entry[0], targets: entry[1] });
            end = j + 1;
        }
        return { start: i, end, indent, items };
    }
    return { start: null, end: lines.length, indent: 2, items: [], top };
}

function unquote(value) {
    if (/^".*"$/.test(value)) { try { return JSON.parse(value); } catch {} }
    if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
    return value;
}

function yamlScalar(value) {
    const plain = /^[A-Za-z_][\w./:@+-]*$/.test(value) && !value.endsWith(':') && !/^(true|false|yes|no|on|off|null)$/i.test(value);
    return plain ? value : JSON.stringify(value);
}

/**
 * The model_list entries, one per deployment: {start, end, indent, name, params}.
 * Several entries with the same model_name are one model that LiteLLM spreads
 * requests across. `start` includes the comment lines right above an entry.
 */
function findModelList(lines) {
    const top = lines.findIndex(l => /^model_list:\s*(#.*)?$/.test(l));
    if (top < 0) return null;
    const items = [];
    let cur = null;
    for (let j = top + 1; j < lines.length; j++) {
        const line = lines[j];
        if (/^\S/.test(line)) break; // the next top-level key (or a comment at column 0)
        if (/^\s*(#.*)?$/.test(line)) continue;
        const m = line.match(/^(\s*)-\s+model_name:\s*(.*?)\s*(#.*)?$/);
        if (m) {
            let start = j;
            while (start - 1 > top && /^\s*#/.test(lines[start - 1])) start--;
            cur = { start, line: j, end: j + 1, indent: m[1].length, name: unquote(m[2]), params: {} };
            items.push(cur);
            continue;
        }
        if (!cur || line.match(/^\s*/)[0].length <= cur.indent) {
            throw new Error(`can't read model_list line ${j + 1}: start each entry with "- model_name:"`);
        }
        const p = line.match(/^\s+(model|api_base|api_key):\s*(.*?)\s*(#.*)?$/);
        if (p && !(p[1] in cur.params)) cur.params[p[1]] = unquote(p[2]);
        cur.end = j + 1;
    }
    // The first entry's comments describe the whole list; leave them to it
    if (items.length) items[0].start = items[0].line;
    return { top, items };
}

// What the page may see of a key: the variable it comes from, never a literal key
function keyLabel(key) {
    if (!key) return null;
    return key.startsWith('os.environ/') ? key : 'set in config.yaml';
}

/** {version, models, deployments, fallbacks: {model: [targets]}}; throws if the file can't be read. */
function parse(text) {
    const lines = text.split(/\r?\n/);
    const block = findBlock(lines);
    const fallbacks = {};
    for (const { source, targets } of block?.items || []) fallbacks[source] = [...(fallbacks[source] || []), ...targets];
    const list = findModelList(lines);
    const deployments = (list?.items || []).map((it, id) => ({
        id, name: it.name, model: it.params.model || null, api_base: it.params.api_base || null, api_key: keyLabel(it.params.api_key),
    }));
    return { version: version(text), models: modelNames(text), deployments, fallbacks };
}

function checkDeployment(d) {
    if (!d || typeof d !== 'object') throw new Error('each new model needs a name and a model id');
    if (typeof d.name !== 'string' || !NAME.test(d.name)) throw new Error(`"${d.name}" isn't a usable Gateway name (letters, digits, . : / @ - _)`);
    if (typeof d.model !== 'string' || !MODEL_ID.test(d.model)) throw new Error(`"${d.model}" isn't a model id, e.g. openrouter/openai/gpt-4o-mini`);
    if (d.api_base && !API_BASE.test(d.api_base)) throw new Error(`"${d.api_base}" isn't an http(s) address`);
    if (d.api_key && !API_KEY.test(d.api_key)) throw new Error('the key must be os.environ/NAME or a placeholder like "dummy"');
}

/**
 * The config text after removing deployments (by id from parse), adding new
 * ones, and setting the fallback chains. `version` must match the file the
 * ids came from, so nothing else is removed if the file changed meanwhile.
 */
function update(text, { version: seen, remove = [], add = [], fallbacks } = {}) {
    if (seen && seen !== version(text)) {
        throw Object.assign(new Error('config.yaml changed since this page loaded it; reload the page and make your change again'), { status: 409 });
    }
    if (!Array.isArray(remove) || !Array.isArray(add)) throw new Error('remove and add must be lists');
    add.forEach(checkDeployment);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let lines = text.split(/\r?\n/);
    const list = findModelList(lines);
    const items = list?.items || [];
    for (const id of remove) if (!Number.isInteger(id) || !items[id]) throw new Error(`no model_list entry ${id}`);
    const before = parse(text).deployments;
    for (const id of [...new Set(remove)].sort((a, b) => items[b].start - items[a].start)) {
        const { start, end } = items[id];
        lines.splice(start, end - start);
        // Don't leave two blank lines where the entry was
        if (start > 0 && /^\s*$/.test(lines[start - 1] ?? 'x') && /^\s*$/.test(lines[start] ?? 'x')) lines.splice(start, 1);
    }
    if (add.length) {
        const indent = ' '.repeat(items[0]?.indent ?? 2);
        const entries = add.flatMap(d => [
            '',
            `${indent}- model_name: ${yamlScalar(d.name)}`,
            `${indent}  litellm_params:`,
            `${indent}    model: ${yamlScalar(d.model)}`,
            ...(d.api_base ? [`${indent}    api_base: ${yamlScalar(d.api_base)}`] : []),
            ...(d.api_key ? [`${indent}    api_key: ${yamlScalar(d.api_key)}`] : []),
        ]);
        const after = findModelList(lines);
        if (after) {
            const last = after.items.length ? after.items[after.items.length - 1].end : after.top + 1;
            lines.splice(last, 0, ...(after.items.length ? entries : entries.slice(1)));
        } else {
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            lines.push('', 'model_list:', ...entries.slice(1), '');
        }
    }
    let out = lines.join(eol);
    // Read it back: exactly the kept entries plus the new ones
    const gone = new Set(remove);
    const expect = [...before.filter(d => !gone.has(d.id)).map(d => `${d.name} ${d.model}`), ...add.map(d => `${d.name} ${d.model}`)];
    const got = parse(out).deployments.map(d => `${d.name} ${d.model}`);
    if (JSON.stringify(got) !== JSON.stringify(expect)) throw new Error("couldn't change model_list without changing other lines; edit config.yaml by hand");
    if (fallbacks) out = write(out, fallbacks);
    return out;
}

function check(fallbacks, models) {
    if (!fallbacks || typeof fallbacks !== 'object' || Array.isArray(fallbacks)) throw new Error('fallbacks must be an object of model -> list');
    const known = new Set(models);
    for (const [source, targets] of Object.entries(fallbacks)) {
        if (!NAME.test(source) || !known.has(source)) throw new Error(`${source} is not a model in config.yaml`);
        if (!Array.isArray(targets)) throw new Error(`fallbacks for ${source} must be a list`);
        for (const t of targets) {
            if (typeof t !== 'string' || !known.has(t)) throw new Error(`${t} (a fallback of ${source}) is not a model in config.yaml`);
            if (t === source) throw new Error(`${source} can't fall back to itself`);
        }
        if (new Set(targets).size !== targets.length) throw new Error(`${source} lists a fallback twice`);
    }
}

/**
 * The config text with these chains. A chain that didn't change keeps its line
 * exactly; a changed one is rewritten in place; an emptied one is removed; a
 * new one goes after the last chain.
 */
function write(text, fallbacks) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const { models } = parse(text);
    check(fallbacks, models);
    const wanted = Object.fromEntries(Object.entries(fallbacks).filter(([, t]) => t.length));
    let block = findBlock(lines);
    if (!block) {
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push('litellm_settings:');
        block = { start: null, end: lines.length, indent: 2, items: [], top: lines.length - 1 };
    }
    if (block.start === null) {
        lines.splice(block.top + 1, 0, `${' '.repeat(block.indent)}fallbacks:`);
        block = { start: block.top + 1, end: block.top + 2, indent: block.indent, items: [] };
    }
    const width = Math.max(0, ...Object.keys(wanted).map(s => s.length + 3));
    const pad = ' '.repeat(block.indent + 2);
    const format = (source) => `${pad}- {${(JSON.stringify(source) + ':').padEnd(width)} ${JSON.stringify(wanted[source]).replace(/","/g, '", "')}}`;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const done = new Set();
    const remove = [];
    for (const item of block.items) {
        if (!(item.source in wanted) || done.has(item.source)) { remove.push(item.line); continue; }
        if (!same(item.targets, wanted[item.source])) lines[item.line] = format(item.source);
        done.add(item.source);
    }
    const added = Object.keys(wanted).filter(s => !done.has(s)).map(format);
    lines.splice(block.end, 0, ...added);
    for (const line of remove.sort((a, b) => b - a)) lines.splice(line, 1);
    const out = lines.join(eol);
    // Read it back: the file must now hold exactly these chains
    if (!same(sorted(parse(out).fallbacks), sorted(wanted))) throw new Error("couldn't write the fallbacks without changing others; edit config.yaml by hand");
    return out;
}

module.exports = { parse, write, update, version, modelNames };
