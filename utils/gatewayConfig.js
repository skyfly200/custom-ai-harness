// The Gateway's (LiteLLM's) config.yaml, as the routing editor sees it: the
// model names it serves and its fallback chains. Only the fallbacks block is
// ever rewritten, line by line, so comments and the rest of the file stay put.
// LiteLLM reads the file at start, so a changed chain needs a Gateway restart.

const NAME = /^[\w.:/@-]+$/;

function modelNames(text) {
    return [...new Set([...text.matchAll(/^\s*-\s*model_name:\s*["']?([^"'\s#]+)/gm)].map(m => m[1]))];
}

// One flow-style item, e.g. {"claude-sonnet-5": ["a", "b"]}; bare names are quoted first.
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

/** {models, fallbacks: {model: [targets]}} from the config text; throws if the fallbacks can't be read. */
function parse(text) {
    const block = findBlock(text.split(/\r?\n/));
    const fallbacks = {};
    for (const { source, targets } of block?.items || []) fallbacks[source] = [...(fallbacks[source] || []), ...targets];
    return { models: modelNames(text), fallbacks };
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

module.exports = { parse, write, modelNames };
