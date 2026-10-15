// Routing editor: the Interceptor, the Router and the Gateway's models as
// boxes, with a line for every place a request can go. Connecting a Router or
// Interceptor output to a model sets that choice; connecting a model's "if it
// fails" dot to another model adds it to that model's fallback chain in
// config.yaml. Model boxes can be added and removed, and so can the provider
// models inside them (config.yaml model_list entries). Save writes each change
// to the file its owner reads.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LAYOUT_KEY = 'harness-routing-layout';
const BACKEND_HELP = {
  routellm: 'RouteLLM BERT, in the Router process.',
  laya: 'Laya in the Router process.',
  systemone: 'Jev via OpenRouter, or a Laya server, over HTTP.',
  llm: 'An OpenAI-compatible model rates difficulty 0 to 1.',
  custom: 'Your own scorer factory.',
};

// Where a new provider model comes from: what the dialog asks for and the
// model_list fields it writes. `prefix` is LiteLLM's provider part of the id.
const PROVIDERS = {
  openrouter: { label: 'OpenRouter', prefix: 'openrouter/', key: 'os.environ/OPENROUTER_API_KEY', example: 'openai/gpt-4o-mini',
    help: 'A model id from openrouter.ai/models; ids ending in :free cost nothing. Uses OPENROUTER_API_KEY from .env.' },
  groq: { label: 'Groq', prefix: 'groq/', key: 'os.environ/GROQ_API_KEY', example: 'openai/gpt-oss-120b',
    help: 'A model id from console.groq.com/docs/models. Uses GROQ_API_KEY from .env.' },
  ollama: { label: 'Ollama on this computer', prefix: 'openai/', base: 'http://localhost:11434/v1', key: 'dummy', example: 'qwen2.5-coder:7b',
    help: 'A model you downloaded with "ollama pull". Ollama must be running.' },
  local: { label: 'Local CLI wrapper (port 8000)', prefix: 'openai/', base: 'http://localhost:8000/v1', key: 'dummy-key-not-needed', example: 'claude-3-5-sonnet-20240620',
    help: 'The model name your local wrapper serves.' },
  openai: { label: 'Other OpenAI-compatible server', prefix: 'openai/', askBase: true, askKey: true, example: 'my-model',
    help: 'Any server with /v1/chat/completions, such as LM Studio, vLLM or llama.cpp.' },
  litellm: { label: 'Any LiteLLM provider (full id)', prefix: '', askBase: true, askKey: true, example: 'anthropic/claude-sonnet-4-5',
    help: 'A full LiteLLM id, provider/model. The list of providers is at docs.litellm.ai/docs/providers.' },
};

// A short name for where a provider model runs, for its tag in a box
function providerOf(d) {
  const base = d.api_base || '';
  if (/:11434\b/.test(base)) return 'Ollama';
  if (/:8000\b/.test(base)) return 'Local';
  const first = (d.model || '').split('/')[0];
  return { openrouter: 'OpenRouter', groq: 'Groq', openai: base ? 'Server' : 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' }[first] || first || '?';
}

// Outputs that pick one model. `key` is the field in the graph below.
const ENTRY_OUTS = [
  { key: 'pin', label: 'Pin every request', help: 'skips the Router' },
  { key: 'down', label: 'Router down', required: true },
  { key: 'downTools', label: 'Router down, with tools', required: true },
];
const ROUTER_OUTS = [
  { key: 'strong', label: 'Strong', help: 'win rate ≥ threshold', required: true },
  { key: 'weak', label: 'Weak', required: true },
  { key: 'tools', label: 'Weak, with tools', help: 'unset: weak' },
  { key: 'overflow', label: 'Weak, over', tokens: true },
];

let info = null;     // what the server reported: router, settings, gateway
let saved = null;    // the graph as the server has it
let graph = null;    // the graph being edited
let positions = {};  // node id -> {x, y}
let selected = null; // id of the selected wire
const flashing = new Map(); // node or wire id -> time the highlight ends
let drag = null;     // a node being moved or a wire being drawn
let focus = null;    // model under the pointer: its fallback lines are drawn in full
let newKeys = 0;     // keys for provider models added on this page (saved ones use their file id)

try { positions = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch {}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const postJSON = (url, body) => getJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function note(text, cls) { $('msg').textContent = text; $('msg').className = 'note ' + (cls || ''); }
const clone = (g) => JSON.parse(JSON.stringify(g));

// ---- the graph -------------------------------------------------------------

function graphFrom({ router, settings, gateway }) {
  const r = router?.settings || {};
  return {
    pin: settings?.pinModel || null,
    down: settings?.routerDownModel || null,
    downTools: settings?.routerDownToolsModel || null,
    threshold: settings?.fixedThreshold ?? null,
    backend: r.backend ?? null,
    strong: r.strong_model ?? null,
    weak: r.weak_model ?? null,
    tools: r.weak_model_tools ?? null,
    overflow: r.weak_model_overflow ?? null,
    maxTokens: r.weak_model_max_tokens ?? null,
    fallbacks: chains(gateway?.fallbacks || {}),
    deployments: (gateway?.deployments || []).map(d => ({ ...d, key: `d${d.id}` })),
  };
}

// Fallbacks without empty chains, sorted, so two can be compared as JSON
function chains(fallbacks) {
  return Object.fromEntries(Object.entries(fallbacks).filter(([, t]) => t.length).sort(([a], [b]) => a.localeCompare(b)));
}

function models() {
  const names = new Set(graph.deployments.map(d => d.name));
  for (const o of [...ENTRY_OUTS, ...ROUTER_OUTS]) if (graph[o.key]) names.add(graph[o.key]);
  for (const [src, targets] of Object.entries(graph.fallbacks)) { names.add(src); targets.forEach(t => names.add(t)); }
  return [...names];
}

const routerUp = () => !!info.router?.settings;
const gatewayEditable = () => !!info.gateway && !info.gatewayError;
const served = (name) => graph.deployments.some(d => d.name === name);

function routerChanges() {
  if (!routerUp()) return {};
  const want = {
    strong_model: graph.strong, weak_model: graph.weak, weak_model_tools: graph.tools,
    weak_model_overflow: graph.overflow, weak_model_max_tokens: graph.overflow ? graph.maxTokens : null,
    backend: graph.backend,
  };
  const have = info.router.settings;
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => (v ?? null) !== (have[k] ?? null)));
}

function interceptorChanges() {
  const want = { pinModel: graph.pin, routerDownModel: graph.down, routerDownToolsModel: graph.downTools, fixedThreshold: graph.threshold };
  const have = info.settings || {};
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => (v ?? null) !== (have[k] ?? null)));
}

// model_list entries to remove (by file id) and to append
function deploymentChanges() {
  const kept = new Set(graph.deployments.map(d => d.id).filter(id => id !== undefined));
  return {
    remove: saved.deployments.filter(d => !kept.has(d.id)).map(d => d.id),
    add: graph.deployments.filter(d => d.id === undefined).map(({ name, model, api_base, api_key }) => ({ name, model, api_base, api_key })),
  };
}

const fallbacksChanged = () => JSON.stringify(chains(graph.fallbacks)) !== JSON.stringify(saved.fallbacks);
const gatewayChanged = () => { const c = deploymentChanges(); return !!(c.remove.length || c.add.length) || fallbacksChanged(); };
const dirty = () => !!graph && (Object.keys(routerChanges()).length || Object.keys(interceptorChanges()).length || gatewayChanged());

function problems() {
  const out = [];
  for (const o of ENTRY_OUTS) if (o.required && !graph[o.key]) out.push(`Connect “${o.label}” to a model.`);
  if (routerUp()) {
    for (const o of ROUTER_OUTS) if (o.required && !graph[o.key]) out.push(`Connect the Router's “${o.label}” output to a model.`);
    if (graph.overflow && !(Number.isInteger(graph.maxTokens) && graph.maxTokens > 0)) out.push('Set the token limit for “Weak, over”.');
  }
  if (graph.threshold !== null && !(graph.threshold >= 0 && graph.threshold <= 1)) out.push('The threshold must be from 0 to 1.');
  if (gatewayEditable()) {
    for (const [src, targets] of Object.entries(graph.fallbacks)) {
      for (const name of [src, ...targets]) if (!served(name)) out.push(`“${name}” has fallback lines but no provider model: add one, or remove its box.`);
    }
  }
  return [...new Set(out)];
}

function connect(port, model) {
  if (port.startsWith('fail:')) {
    const src = port.slice(5);
    const chain = graph.fallbacks[src] || [];
    if (src === model || chain.includes(model)) return;
    graph.fallbacks[src] = [...chain, model];
  } else {
    graph[port.split('.')[1]] = model;
  }
  changed();
}

function removeWire(id) {
  if (!id) return;
  if (id.startsWith('fb|')) {
    const [, src, target] = id.split('|');
    graph.fallbacks[src] = (graph.fallbacks[src] || []).filter(t => t !== target);
    if (!graph.fallbacks[src].length) delete graph.fallbacks[src];
  } else {
    graph[id.split('.')[1]] = null;
  }
  selected = null;
  changed();
}

function removeModel(name) {
  const uses = [...ENTRY_OUTS, ...ROUTER_OUTS].filter(o => graph[o.key] === name).map(o => `“${o.label}”`);
  const count = graph.deployments.filter(d => d.name === name).length;
  const ask = `Remove ${name}?` + (count ? ` Its ${count === 1 ? 'provider model' : `${count} provider models`} and fallback lines go with it.` : '')
    + (uses.length ? `\n\nIt is used for ${uses.join(', ')}. Connect ${uses.length === 1 ? 'that' : 'those'} to another model before saving.` : '')
    + '\n\nNothing changes in the files until you press Save.';
  if (!confirm(ask)) return;
  graph.deployments = graph.deployments.filter(d => d.name !== name);
  delete graph.fallbacks[name];
  for (const [src, targets] of Object.entries(graph.fallbacks)) {
    const kept = targets.filter(t => t !== name);
    if (kept.length) graph.fallbacks[src] = kept; else delete graph.fallbacks[src];
  }
  for (const o of [...ENTRY_OUTS, ...ROUTER_OUTS]) if (graph[o.key] === name) graph[o.key] = null;
  selected = null;
  changed();
}

function removeDeployment(key) {
  graph.deployments = graph.deployments.filter(d => d.key !== key);
  changed();
}

function changed() {
  render();
  updateButtons();
}

function updateButtons() {
  const d = dirty();
  $('save').disabled = !d;
  $('discard').disabled = !d;
  $('remove').disabled = !selected;
  if (d) note(problems()[0] || 'Unsaved changes.', problems().length ? 'err' : '');
}

// ---- drawing -----------------------------------------------------------------

const OUT_HINTS = {
  pin: 'Connect to send every request to one model and skip the Router. Remove the line to turn it off',
  down: 'Where requests go when the Router doesn’t answer in time',
  downTools: 'Same, for requests that carry tools (all Claude Code requests)',
  strong: 'Hard requests: the classifier’s score is at or above the threshold',
  weak: 'Easy requests without tools',
  tools: 'Easy requests that carry tools (all Claude Code requests). Unset sends them to Weak',
  overflow: 'Easy requests bigger than this many tokens (e.g. over a free tier’s limit). Unset means no limit',
};

function outRow(id, o, { model, disabled }) {
  const empty = !model;
  const target = empty ? `<span class="unset">${o.required ? 'not connected' : 'off'}</span>` : '';
  const tokens = o.tokens ? ` <input type="number" min="1" step="1" data-field="maxTokens" value="${esc(graph.maxTokens ?? '')}" placeholder="tokens"${disabled ? ' disabled' : ''}>` : '';
  return `<div class="out${o.required ? ' required' : ''}${empty ? ' empty' : ''}" data-hint="${esc(OUT_HINTS[o.key] || '')}">
    <span class="label"><b>${esc(o.label)}</b>${o.help ? ` <span>· ${esc(o.help)}</span>` : ''} ${target}</span>${tokens}
    <span class="port out-port${disabled ? ' fixed' : ''}" data-port="${id}"></span></div>`;
}

const KIND_HINTS = {
  Interceptor: 'Every request from Claude Code, the chat page or other clients arrives here first',
  Classifier: 'Scores how hard each request is and picks a model from the outputs below',
  Model: 'A name the Gateway (LiteLLM) serves. Drag the title to move the box',
};

function nodeHTML(id, cls, title, kind, body, outs, hasIn, extra = '') {
  return `<div class="node ${cls}" data-id="${esc(id)}"${cls === 'model' ? ` data-model="${esc(title)}"` : ''}>
    ${hasIn ? '<span class="port in-port"></span>' : ''}
    <div class="head" data-hint="${esc(KIND_HINTS[kind] || '')}"><span class="name">${esc(title)}</span><span class="kind">${esc(kind)}</span>${extra}</div>
    <div class="body">${body}</div>${outs ? `<div class="outs">${outs}</div>` : ''}</div>`;
}

function entryNode() {
  const body = graph.pin ? `<div class="warn">Pinned: every request goes to <b>${esc(graph.pin)}</b> and the Router is skipped.</div>` : '';
  const outs = `<div class="out" data-hint="Unless a model is pinned, every request is scored by the Router"><span class="label"><b>Router</b> · scores each request</span><span class="port out-port fixed" data-port="entry.router"></span></div>`
    + ENTRY_OUTS.map(o => outRow(`entry.${o.key}`, o, { model: graph[o.key] })).join('');
  return nodeHTML('entry', 'entry', 'Request', 'Interceptor', body, outs, false);
}

function routerNode() {
  const up = routerUp();
  const backends = info.router?.backends || (graph.backend ? [graph.backend] : []);
  const body = (up ? '' : '<div class="warn">The Router is down, so its choices can’t be read or changed. Start it and reload this page.</div>')
    + `<label data-hint="How requests are scored. Its other settings (address, key, timeout) are on the Dashboard">Classifier<select data-field="backend"${up ? '' : ' disabled'}>${backends.map(b => `<option${b === graph.backend ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>
       <small id="backendHelp">${esc(BACKEND_HELP[graph.backend] || '')}</small></label>
     <label data-hint="Requests scoring at or above this go to Strong. Empty uses the keyword rule">Threshold<input type="number" min="0" max="1" step="0.05" data-field="threshold" value="${esc(graph.threshold ?? '')}" placeholder="from keywords (0.2 / 0.5 / 0.8)">
       <small>0 always strong, 1 almost always weak.</small></label>`;
  const outs = ROUTER_OUTS.map(o => outRow(`router.${o.key}`, o, { model: graph[o.key], disabled: !up })).join('');
  return nodeHTML('router', 'router' + (graph.pin ? ' dim' : ''), 'Router', 'Classifier', body, outs, true);
}

function deploymentRow(d, only) {
  const id = d.model || '(no model id)';
  const where = [d.model, d.api_base && `at ${d.api_base}`, d.api_key && `key: ${d.api_key}`].filter(Boolean).join('\n');
  const remove = gatewayEditable()
    ? `<button data-act="undeploy" data-key="${esc(d.key)}" data-hint="${only ? 'The last provider model can’t be removed on its own: remove the whole box with × in its title' : `Stop sending ${esc(d.name)} requests to this model`}"${only ? ' disabled' : ''}>×</button>`
    : '';
  return `<li${d.id === undefined ? ' class="new"' : ''}><span class="tag" data-hint="${esc(where)}">${esc(providerOf(d))}</span>
    <span class="name" data-hint="${esc(where)}">${esc(id.replace(/^(openrouter|groq|openai)\//, ''))}</span>${remove}</li>`;
}

function modelNode(name) {
  const chain = graph.fallbacks[name] || [];
  const editable = gatewayEditable();
  const deps = graph.deployments.filter(d => d.name === name);
  const servedBy = editable
    ? `<div class="sect" data-hint="The provider models that actually answer requests for ${esc(name)}. With more than one, the Gateway spreads requests across them.">Served by</div>
       ${deps.length ? `<ul class="deps">${deps.map(d => deploymentRow(d, deps.length === 1)).join('')}</ul>`
         : '<div class="warn">No provider model, so the Gateway can’t serve it. Add one, or remove this box.</div>'}
       <button class="add-dep" data-act="adddep" data-name="${esc(name)}" data-hint="Add another provider model under this name; the Gateway shares requests between them">+ Add provider model</button>`
    : '';
  const list = chain.length
    ? `<div class="sect" data-hint="When ${esc(name)} fails (error, rate limit, timeout) the Gateway tries these, top first">Fallbacks</div>
       <ol class="chain">${chain.map((t, i) => `<li><span class="n">${i + 1}</span><span class="name" title="${esc(t)}">${esc(t)}</span>${editable ? `
        <button data-act="up" data-src="${esc(name)}" data-i="${i}" data-hint="Try earlier"${i ? '' : ' disabled'}>↑</button>
        <button data-act="down" data-src="${esc(name)}" data-i="${i}" data-hint="Try later"${i < chain.length - 1 ? '' : ' disabled'}>↓</button>
        <button data-act="del" data-src="${esc(name)}" data-i="${i}" data-hint="Remove this fallback">×</button>` : ''}</li>`).join('')}</ol>`
    : '';
  const outs = `<div class="out"><span class="label"><b>If it fails</b>${chain.length ? ', try in order' : ' · no fallbacks'}</span>
    <span class="port out-port fallback${editable ? '' : ' fixed'}" data-port="fail:${esc(name)}" data-hint="Drag to another model to try it when ${esc(name)} fails"></span></div>`;
  const close = editable ? `<button class="close" data-act="unmodel" data-name="${esc(name)}" data-hint="Remove ${esc(name)} from the Gateway, with its provider models and fallback lines">×</button>` : '';
  return nodeHTML(`m:${name}`, 'model', name, 'Model', servedBy + list, outs, true, close);
}

function render() {
  const world = $('world');
  const keep = $('wires');
  world.innerHTML = entryNode() + routerNode() + models().map(modelNode).join('');
  world.prepend(keep);
  placeNodes();
  drawWires();
}

// Saved spots first; anything new is stacked in a column: route targets, then the rest
function placeNodes() {
  const nodes = [...$('world').querySelectorAll('.node')];
  const byId = Object.fromEntries(nodes.map(n => [n.dataset.id, n]));
  const columns = { 0: 30, 1: 380, 2: 720 };
  const next = { 0: 30, 1: 30, 2: 30 };
  // Columns fill below what is already placed in them
  for (const n of nodes) {
    const p = positions[n.dataset.id];
    if (!p) continue;
    const col = p.x < 300 ? 0 : p.x < 650 ? 1 : 2;
    next[col] = Math.max(next[col], p.y + n.offsetHeight + 24);
  }
  const routed = new Set([...ENTRY_OUTS, ...ROUTER_OUTS].map(o => graph[o.key]).filter(Boolean));
  const order = ['entry', 'router', ...[...routed].map(m => `m:${m}`), ...models().filter(m => !routed.has(m)).map(m => `m:${m}`)];
  for (const id of order) {
    const n = byId[id];
    if (!n || positions[id]) continue;
    const col = id === 'entry' || id === 'router' ? 0 : routed.has(id.slice(2)) ? 1 : 2;
    positions[id] = { x: columns[col], y: next[col] };
    next[col] += n.offsetHeight + 24;
  }
  let w = 0, h = 0;
  for (const n of nodes) {
    const p = positions[n.dataset.id];
    n.style.left = p.x + 'px';
    n.style.top = p.y + 'px';
    w = Math.max(w, p.x + n.offsetWidth);
    h = Math.max(h, p.y + n.offsetHeight);
  }
  $('world').style.width = w + 200 + 'px';
  $('world').style.height = h + 200 + 'px';
}

function wireList() {
  const list = [{ id: 'fixed', from: 'entry.router', to: 'router', cls: 'fixed', dim: !!graph.pin }];
  for (const o of ENTRY_OUTS) if (graph[o.key]) list.push({ id: `entry.${o.key}`, from: `entry.${o.key}`, to: `m:${graph[o.key]}` });
  for (const o of ROUTER_OUTS) if (graph[o.key]) list.push({ id: `router.${o.key}`, from: `router.${o.key}`, to: `m:${graph[o.key]}`, dim: !!graph.pin });
  for (const [src, targets] of Object.entries(graph.fallbacks)) {
    // Faint unless their model is under the pointer or selected, so the chains don't hide the routes
    targets.forEach((t, i) => {
      const id = ['fb', src, t].join('|');
      const full = focus === src || focus === t || selected === id;
      list.push({ id, from: `fail:${src}`, to: `m:${t}`, cls: full ? 'fallback' : 'fallback faint', order: full && i + 1 });
    });
  }
  return list;
}

function pointIn(el) {
  const r = el.getBoundingClientRect(), w = $('world').getBoundingClientRect();
  return { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2 };
}

function curve(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function drawWires() {
  const world = $('world');
  const now = Date.now();
  const parts = [];
  for (const w of wireList()) {
    const from = world.querySelector(`.out-port[data-port="${CSS.escape(w.from)}"]`);
    const to = world.querySelector(`.node[data-id="${CSS.escape(w.to)}"] .in-port`);
    if (!from || !to) continue;
    const a = pointIn(from), b = pointIn(to);
    const d = curve(a, b);
    const cls = ['wire', w.cls, w.dim && 'dim', selected === w.id && 'selected', (flashing.get(w.id) || 0) > now && 'flash'].filter(Boolean).join(' ');
    parts.push(`<path class="${cls}" d="${d}"/>`);
    if (w.order) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      parts.push(`<circle class="order" cx="${mx}" cy="${my}" r="8"/><text class="order-text" x="${mx}" y="${my}">${w.order}</text>`);
    }
    if (w.id !== 'fixed') parts.push(`<path class="hit" data-wire="${esc(w.id)}" data-hint="Click to select this line, then press Delete or Remove connection" d="${d}"/>`);
  }
  if (drag?.draft) parts.push(`<path class="wire draft" d="${curve(drag.draft.a, drag.draft.b)}"/>`);
  $('wires').innerHTML = parts.join('');
  for (const n of world.querySelectorAll('.node')) n.classList.toggle('flash', (flashing.get(n.dataset.id) || 0) > now);
}

// ---- interaction -----------------------------------------------------------

function worldPoint(e) {
  const w = $('world').getBoundingClientRect();
  return { x: e.clientX - w.left, y: e.clientY - w.top };
}

function modelAt(e) {
  return document.elementFromPoint(e.clientX, e.clientY)?.closest('.node.model') || null;
}

$('world').addEventListener('pointerdown', (e) => {
  const port = e.target.closest('.out-port');
  if (port && !port.classList.contains('fixed')) {
    e.preventDefault();
    port.setPointerCapture(e.pointerId);
    drag = { kind: 'wire', port: port.dataset.port, draft: { a: pointIn(port), b: worldPoint(e) } };
    drawWires();
    return;
  }
  const head = e.target.closest('.head');
  if (head && !e.target.closest('button')) {
    e.preventDefault();
    const node = head.parentElement;
    head.setPointerCapture(e.pointerId);
    const p = positions[node.dataset.id];
    drag = { kind: 'move', node, start: worldPoint(e), from: { ...p } };
    return;
  }
  const hit = e.target.closest('[data-wire]');
  selected = hit ? hit.dataset.wire : null;
  drawWires();
  updateButtons();
});

$('world').addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'move') {
    const p = worldPoint(e);
    const pos = { x: Math.max(0, drag.from.x + p.x - drag.start.x), y: Math.max(0, drag.from.y + p.y - drag.start.y) };
    positions[drag.node.dataset.id] = pos;
    drag.node.style.left = pos.x + 'px';
    drag.node.style.top = pos.y + 'px';
    drawWires();
  } else {
    drag.draft.b = worldPoint(e);
    for (const n of $('world').querySelectorAll('.node.drop')) n.classList.remove('drop');
    modelAt(e)?.classList.add('drop');
    drawWires();
  }
});

function endDrag(e) {
  if (!drag) return;
  const was = drag;
  drag = null;
  if (was.kind === 'move') {
    placeNodes();
    drawWires();
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions)); } catch {}
    return;
  }
  const target = e.type === 'pointerup' ? modelAt(e) : null;
  if (target) connect(was.port, target.dataset.model);
  else render();
}
$('world').addEventListener('pointerup', endDrag);
$('world').addEventListener('pointercancel', endDrag);

$('world').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'unmodel') return removeModel(b.dataset.name);
  if (b.dataset.act === 'undeploy') return removeDeployment(b.dataset.key);
  if (b.dataset.act === 'adddep') return openAdd(b.dataset.name);
  const chain = [...graph.fallbacks[b.dataset.src]];
  const i = Number(b.dataset.i);
  if (b.dataset.act === 'del') chain.splice(i, 1);
  else {
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    [chain[i], chain[j]] = [chain[j], chain[i]];
  }
  if (chain.length) graph.fallbacks[b.dataset.src] = chain; else delete graph.fallbacks[b.dataset.src];
  changed();
});

$('world').addEventListener('pointerover', (e) => {
  const model = drag ? null : e.target.closest('.node.model')?.dataset.model || null;
  if (model !== focus) { focus = model; drawWires(); }
});
$('world').addEventListener('pointerleave', () => { if (focus) { focus = null; drawWires(); } });

// Inputs change the graph without redrawing it, so typing keeps focus
$('world').addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const raw = e.target.value.trim();
  if (field === 'backend') {
    graph.backend = raw;
    $('backendHelp').textContent = BACKEND_HELP[raw] || '';
  } else {
    graph[field] = raw === '' ? null : Number(raw);
  }
  updateButtons();
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.target.closest('input, select, textarea')) {
    e.preventDefault();
    removeWire(selected);
  }
});
$('remove').addEventListener('click', () => removeWire(selected));

$('tidy').addEventListener('click', () => {
  positions = {};
  try { localStorage.removeItem(LAYOUT_KEY); } catch {}
  render();
});

$('discard').addEventListener('click', () => {
  graph = clone(saved);
  selected = null;
  changed();
  note('');
});

$('save').addEventListener('click', async () => {
  const issues = problems();
  if (issues.length) return note(issues[0], 'err');
  $('save').disabled = $('discard').disabled = true;
  const done = [];
  let restart = false;
  try {
    // The Gateway first: the Router may name a model that is only added here
    if (gatewayChanged()) {
      note('Writing config.yaml…');
      info.gateway = await postJSON('api/gateway', { version: info.gateway.version, ...deploymentChanges(), fallbacks: chains(graph.fallbacks) });
      graph.deployments = graphFrom(info).deployments;
      done.push('Gateway models and fallbacks');
      restart = true;
    }
    const rc = routerChanges();
    if (Object.keys(rc).length) {
      note(rc.backend ? 'Saving the Router… (a classifier change can load a model)' : 'Saving the Router…');
      await postJSON('api/router/config', { changes: rc });
      info.router = (await postJSON('api/router/save', {}));
      done.push('Router');
    }
    const ic = interceptorChanges();
    if (Object.keys(ic).length) {
      note('Saving the Interceptor…');
      info.settings = (await postJSON('api/settings', ic)).settings;
      done.push('Interceptor');
    }
    saved = graphFrom(info);
    note(`Saved: ${done.join(', ')}.${restart ? ' Restart the Gateway (LiteLLM) to use the new models and fallbacks.' : ''}`, 'ok');
  } catch (err) {
    saved = graphFrom(info); // keep whatever did save
    note(`${done.length ? `Saved ${done.join(', ')}, but ` : ''}${err.message}`, 'err');
  }
  const message = $('msg').textContent, cls = $('msg').className;
  updateButtons();
  $('msg').textContent = message; $('msg').className = cls;
});

window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
window.addEventListener('resize', () => graph && drawWires());

// ---- adding models ----------------------------------------------------------

// Opens the dialog for a new model box, or with `name` for another provider model in that box
function openAdd(name) {
  const f = $('addForm');
  f.reset();
  f.dataset.name = name || '';
  $('addTitle').textContent = name ? `Add a provider model to ${name}` : 'Add a model';
  $('addIntro').textContent = name
    ? `The Gateway will share ${name}'s requests between its provider models.`
    : 'A new name the Gateway serves, and the provider model that answers it. Connect it to the Router or other models after adding.';
  $('nameField').hidden = !!name;
  f.elements.name.required = !name;
  $('addMsg').textContent = '';
  showProvider();
  $('addDialog').showModal();
  (name ? f.elements.provider : f.elements.name).focus();
}

function showProvider() {
  const f = $('addForm');
  const p = PROVIDERS[f.elements.provider.value];
  $('providerHelp').textContent = p.help;
  f.elements.model.placeholder = p.example;
  $('baseField').hidden = !p.askBase;
  $('keyField').hidden = !p.askKey;
}

$('addForm').elements.provider.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
$('addForm').elements.provider.addEventListener('change', showProvider);
$('addModel').addEventListener('click', () => openAdd(''));
$('addCancel').addEventListener('click', () => $('addDialog').close());

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = $('addForm');
  const fail = (text) => { $('addMsg').textContent = text; };
  const name = f.dataset.name || f.elements.name.value.trim();
  const p = PROVIDERS[f.elements.provider.value];
  const typed = f.elements.model.value.trim();
  const id = p.prefix && typed.startsWith(p.prefix) ? typed.slice(p.prefix.length) : typed;
  const base = f.elements.api_base.value.trim();
  const keyName = f.elements.api_key_env.value.trim();
  if (!/^[\w.:/@-]+$/.test(name)) return fail('Use letters, digits and . : / @ - _ in the name.');
  if (!f.dataset.name && models().includes(name)) return fail(`${name} already exists: use “+ Add provider model” in its box to add to it.`);
  if (!/^[\w.:/@+-]+$/.test(id)) return fail(`Enter the model id, e.g. ${p.example}.`);
  if (p.askBase && base && !/^https?:\/\/\S+$/.test(base)) return fail('The server address starts with http:// or https://.');
  if (p.askBase && !base && p.prefix === 'openai/') return fail('Enter the server address, e.g. http://localhost:1234/v1.');
  if (keyName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) return fail('Enter the name of the variable in .env, like MY_API_KEY, not the key itself.');
  const model = p.prefix + id;
  if (graph.deployments.some(d => d.name === name && d.model === model && (d.api_base || '') === (p.base || base))) return fail(`${name} already uses ${model}.`);
  graph.deployments.push({
    key: `n${++newKeys}`, name, model,
    api_base: p.base || base || null,
    api_key: p.key || (keyName ? `os.environ/${keyName}` : (p.prefix === 'openai/' ? 'dummy' : null)),
  });
  $('addDialog').close();
  changed();
  // Bring a new box into view
  const node = $('world').querySelector(`.node[data-id="${CSS.escape('m:' + name)}"]`);
  node?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  flash([`m:${name}`]);
});

// ---- the guide ---------------------------------------------------------------

// Open until the reader closes it once
try { $('guide').open = localStorage.getItem('harness-routing-guide') !== 'closed'; } catch { $('guide').open = true; }
$('guide').addEventListener('toggle', () => {
  try { localStorage.setItem('harness-routing-guide', $('guide').open ? 'open' : 'closed'); } catch {}
});

// ---- loading and live requests -------------------------------------------

async function load() {
  const [status, settings, gateway] = await Promise.allSettled([getJSON('api/status'), getJSON('api/settings'), getJSON('api/gateway')]);
  const router = status.value?.components?.find(c => c.name === 'Router');
  info = {
    router: router?.ok && router.detail?.settings ? router.detail : null,
    settings: settings.value?.settings || null,
    gateway: gateway.value || null,
    gatewayError: gateway.reason?.message || null,
  };
  saved = graphFrom(info);
  graph = clone(saved);
  $('routerFile').innerHTML = info.router?.config ? `<code>${esc(info.router.config)}</code>` : 'its config file';
  if (info.gateway?.file) $('gatewayFile').textContent = info.gateway.file;
  const issues = [
    !info.settings && `Interceptor settings: ${settings.reason?.message}`,
    !info.router && 'The Router is down or has no admin endpoints, so its choices can’t be changed.',
    info.gatewayError && `Models and fallbacks can’t be edited: ${info.gatewayError}`,
  ].filter(Boolean);
  $('updated').textContent = `Loaded ${new Date().toLocaleTimeString()}`;
  $('addModel').disabled = !gatewayEditable();
  render();
  updateButtons();
  note(issues.join(' '), issues.length ? 'err' : '');
}

function flash(ids) {
  const until = Date.now() + 1600;
  for (const id of ids) flashing.set(id, until);
  drawWires();
  setTimeout(drawWires, 1700);
}

function followLive() {
  let source;
  try { source = new EventSource('api/live'); } catch { return; }
  source.onmessage = (msg) => {
    if (!graph || !$('live').checked) return;
    let update;
    try { update = JSON.parse(msg.data); } catch { return; }
    const e = update.event || {};
    if (update.type === 'route' && e.model) {
      let wires;
      if (e.reason === 'pinned in settings') wires = ['entry.pin'];
      else if (e.reason) wires = [];
      else if (e.routerError) wires = [e.tools ? 'entry.downTools' : 'entry.down'];
      else wires = ['fixed', ...ROUTER_OUTS.filter(o => graph[o.key] === e.model).map(o => `router.${o.key}`)];
      flash([...wires, `m:${e.model}`]);
    } else if (update.type === 'response' && e.servedBy && e.servedBy !== e.model) {
      flash([['fb', e.model, e.servedBy].join('|'), `m:${e.servedBy}`]);
    }
  };
}

load().catch(err => note(err.message, 'err'));
followLive();
