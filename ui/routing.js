// Routing editor: the Interceptor, the Router and the Gateway's models as
// boxes, with a line for every place a request can go. Connecting a Router or
// Interceptor output to a model sets that choice; connecting a model's "if it
// fails" dot to another model adds it to that model's fallback chain in
// config.yaml. Model boxes can be added and removed, and so can the provider
// models inside them (config.yaml model_list entries). Save writes each change
// to the file its owner reads.
//
// Named routings (profiles) are other sets of route choices, compression and
// tools, picked per chat or project on the chat page. The picker above the
// canvas switches which routing the Request, Compression, Router and Tools
// boxes show; model boxes and fallbacks belong to the Gateway and every
// routing shares them.

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
let view = '';       // the routing being shown: '' for the default, else a profile id
let toolInfo = null; // MCP servers (GET api/tools)

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
    caveman: settings?.caveman ?? true,
    headroom: settings?.headroom ?? true,
    contextAnchor: settings?.contextAnchor ?? true,
    mcpOff: settings?.mcpOff || [],
    fallbacks: chains(gateway?.fallbacks || {}),
    deployments: (gateway?.deployments || []).map(d => ({ ...d, key: `d${d.id}` })),
    profiles: clone(info.profiles?.profiles || []),
  };
}

// The routing being edited: the default (kept on the graph itself) or a profile
const R = () => (view && graph.profiles.find(p => p.id === view)) || graph;
const routings = () => [graph, ...graph.profiles];
const ROUTE_FIELDS = ['pin', 'down', 'downTools', 'threshold', 'strong', 'weak', 'tools', 'overflow', 'maxTokens', 'caveman', 'headroom', 'contextAnchor', 'mcpOff'];
const routingName = (r) => (r === graph ? 'the default routing' : `“${r.name}”`);

// Fallbacks without empty chains, sorted, so two can be compared as JSON
function chains(fallbacks) {
  return Object.fromEntries(Object.entries(fallbacks).filter(([, t]) => t.length).sort(([a], [b]) => a.localeCompare(b)));
}

function models() {
  const names = new Set(graph.deployments.map(d => d.name));
  for (const r of routings()) for (const o of [...ENTRY_OUTS, ...ROUTER_OUTS]) if (r[o.key]) names.add(r[o.key]);
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
  const want = {
    pinModel: graph.pin, routerDownModel: graph.down, routerDownToolsModel: graph.downTools, fixedThreshold: graph.threshold,
    caveman: graph.caveman, headroom: graph.headroom, contextAnchor: graph.contextAnchor, mcpOff: graph.mcpOff,
  };
  const have = info.settings || {};
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(have[k] ?? null)));
}

const profilesChanged = () => JSON.stringify(graph.profiles) !== JSON.stringify(saved.profiles);

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
const dirty = () => !!graph && (Object.keys(routerChanges()).length || Object.keys(interceptorChanges()).length || gatewayChanged() || profilesChanged());

function problems() {
  const out = [];
  // The routing on screen first, so its problems are the ones shown
  for (const r of [R(), ...routings().filter(x => x !== R())]) {
    const where = r === R() ? '' : ` (in ${routingName(r)})`;
    for (const o of ENTRY_OUTS) if (o.required && !r[o.key]) out.push(`Connect “${o.label}” to a model${where}.`);
    // A profile's Router outputs are its own; the default's live in the Router
    if (r === graph ? routerUp() : !r.pin) {
      for (const o of ROUTER_OUTS) if (o.required && !r[o.key]) out.push(`Connect the Router's “${o.label}” output to a model${where}.`);
    }
    if (r.overflow && !(Number.isInteger(r.maxTokens) && r.maxTokens > 0)) out.push(`Set the token limit for “Weak, over”${where}.`);
    if (r.threshold !== null && !(r.threshold >= 0 && r.threshold <= 1)) out.push(`The threshold must be from 0 to 1${where}.`);
  }
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
    R()[port.split('.')[1]] = model;
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
    R()[id.split('.')[1]] = null;
  }
  selected = null;
  changed();
}

function removeModel(name) {
  const uses = routings().flatMap(r => [...ENTRY_OUTS, ...ROUTER_OUTS].filter(o => r[o.key] === name)
    .map(o => `“${o.label}”${r === graph ? '' : ` in ${r.name}`}`));
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
  for (const r of routings()) for (const o of [...ENTRY_OUTS, ...ROUTER_OUTS]) if (r[o.key] === name) r[o.key] = null;
  selected = null;
  changed();
}

// Models no route (in any routing) or fallback line touches
function unconnected() {
  const used = new Set();
  for (const r of routings()) for (const o of [...ENTRY_OUTS, ...ROUTER_OUTS]) if (r[o.key]) used.add(r[o.key]);
  for (const [src, targets] of Object.entries(graph.fallbacks)) { used.add(src); targets.forEach(t => used.add(t)); }
  return models().filter(m => !used.has(m));
}

function clearUnconnected() {
  const names = unconnected();
  if (!names.length) return;
  const count = graph.deployments.filter(d => names.includes(d.name)).length;
  if (!confirm(`Remove ${names.length} unconnected model${names.length === 1 ? '' : 's'}${count ? ` and ${count === 1 ? 'its provider model' : `their ${count} provider models`}` : ''}?\n\n${names.join('\n')}\n\nNothing changes in config.yaml until you press Save.`)) return;
  graph.deployments = graph.deployments.filter(d => !names.includes(d.name));
  for (const n of names) delete positions[`m:${n}`];
  selected = null;
  changed();
  note(`Removed ${names.length} unconnected model${names.length === 1 ? '' : 's'}. Press Save to write config.yaml, then restart the Gateway.`);
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
  const spare = gatewayEditable() ? unconnected().length : 0;
  $('clearUnused').disabled = !spare;
  $('clearUnused').textContent = spare ? `Clear unconnected models (${spare})` : 'Clear unconnected models';
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
  const tokens = o.tokens ? ` <input type="number" min="1" step="1" data-field="maxTokens" value="${esc(R().maxTokens ?? '')}" placeholder="tokens"${disabled ? ' disabled' : ''}>` : '';
  return `<div class="out${o.required ? ' required' : ''}${empty ? ' empty' : ''}" data-hint="${esc(OUT_HINTS[o.key] || '')}">
    <span class="label"><b>${esc(o.label)}</b>${o.help ? ` <span>· ${esc(o.help)}</span>` : ''} ${target}</span>${tokens}
    <span class="port out-port${disabled ? ' fixed' : ''}" data-port="${id}"></span></div>`;
}

const KIND_HINTS = {
  Interceptor: 'Every request from Claude Code, the chat page or other clients arrives here first',
  Classifier: 'Scores how hard each request is and picks a model from the outputs below',
  Model: 'A name the Gateway (LiteLLM) serves. Drag the title to move the box',
  Transforms: 'What the Interceptor does to each request before it goes on, to save tokens',
  MCP: 'Tool servers from mcp-servers.json that Bright Chat offers the model',
};

function nodeHTML(id, cls, title, kind, body, outs, hasIn, extra = '') {
  return `<div class="node ${cls}" data-id="${esc(id)}"${cls === 'model' ? ` data-model="${esc(title)}"` : ''}>
    ${hasIn ? '<span class="port in-port"></span>' : ''}
    <div class="head" data-hint="${esc(KIND_HINTS[kind] || '')}"><span class="name">${esc(title)}</span><span class="kind">${esc(kind)}</span>${extra}</div>
    <div class="body">${body}</div>${outs ? `<div class="outs">${outs}</div>` : ''}</div>`;
}

function entryNode() {
  const r = R();
  const body = (r.pin ? `<div class="warn">Pinned: every request goes to <b>${esc(r.pin)}</b> and the Router is skipped.</div>` : '');
  const outs = `<div class="out" data-hint="Every request is compressed first, then scored by the Router unless a model is pinned"><span class="label"><b>Compression</b>, then the Router</span><span class="port out-port fixed" data-port="entry.router"></span></div>`
    + ENTRY_OUTS.map(o => outRow(`entry.${o.key}`, o, { model: r[o.key] })).join('');
  return nodeHTML('entry', 'entry', 'Request', 'Interceptor', body, outs, false);
}

const TRANSFORMS = [
  { key: 'caveman', label: 'Short replies (caveman)', help: 'Adds a line to the system prompt asking for terse answers. Saves output tokens.' },
  { key: 'headroom', label: 'Shrink tool results (Headroom)', help: 'Cuts long tool output (logs, file dumps) down to the parts that matter. Saves input tokens.' },
  { key: 'contextAnchor', label: 'Skip repeated tool results', help: 'A tool result identical to an earlier one is replaced by a pointer to it.' },
];

function compressNode() {
  const r = R();
  const on = TRANSFORMS.filter(t => r[t.key]).length;
  const body = TRANSFORMS.map(t => `<label class="check" data-hint="${esc(t.help)}"><input type="checkbox" data-toggle="${t.key}"${r[t.key] ? ' checked' : ''}> ${esc(t.label)}</label>`).join('')
    + `<small>${on ? `${on} of 3 on.` : 'Off: requests go on unchanged.'} Runs on every request on this routing, pinned ones too.</small>`;
  const outs = `<div class="out"><span class="label"><b>Router</b> · scores each request</span><span class="port out-port fixed" data-port="compress.router"></span></div>`;
  return nodeHTML('compress', 'compress', 'Compression', 'Transforms', body, outs, true);
}

function toolsNode() {
  const r = R();
  const off = new Set(r.mcpOff || []);
  const servers = toolInfo?.servers || [];
  const rows = servers.map(s => {
    const dot = s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'bad' : 'off';
    const detail = s.status === 'connected' ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : s.status === 'disabled' ? 'disabled in the file' : s.status;
    const tip = s.error || s.tools.map(t => `${t.title || t.name}: ${t.description || ''}`.slice(0, 140)).join('\n');
    return `<li data-hint="${esc(tip)}"><label class="check"><input type="checkbox" data-mcp="${esc(s.name)}"${off.has(s.name) ? '' : ' checked'}>
      <span class="dot ${dot}"></span><span class="name">${esc(s.name)}</span><span class="muted">${esc(detail)}</span></label></li>`;
  });
  const body = `<ul class="mcp">${rows.join('') || `<li class="muted small">${toolInfo ? `No servers. List them in <code>${esc((toolInfo.file || 'mcp-servers.json').split(/[\\/]/).pop())}</code> next to server.js.` : 'Couldn’t read the tool servers.'}</li>`}</ul>
    <small>Ticked servers are offered to the model in Bright Chat chats on this routing (each chat can still turn them off in Options). Claude Code brings its own tools.</small>
    <button class="add-dep" data-act="reloadtools" data-hint="Read mcp-servers.json again and reconnect every server">Reload servers</button>`;
  return nodeHTML('tools', 'tools', 'Tools', 'MCP', body, '', false);
}

function routerNode() {
  const up = routerUp();
  const r = R();
  // The default's outputs are the Router's own; a profile keeps its outputs here and only borrows the score
  const editable = r === graph ? up : true;
  const backends = info.router?.backends || (graph.backend ? [graph.backend] : []);
  const body = (up ? '' : r === graph ? '<div class="warn">The Router is down, so its choices can’t be read or changed. Start it and reload this page.</div>'
      : '<div class="warn">The Router is down: requests on this routing go to “Router down” until it is back.</div>')
    + `<label data-hint="How requests are scored. Every routing shares it. Its other settings (address, key, timeout) are on the Settings page">Classifier${view ? ' · shared' : ''}<select data-field="backend"${up ? '' : ' disabled'}>${backends.map(b => `<option${b === graph.backend ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>
       <small id="backendHelp">${esc(BACKEND_HELP[graph.backend] || '')}</small></label>
     <label data-hint="Requests scoring at or above this go to Strong. Empty uses the keyword rule">Threshold<input type="number" min="0" max="1" step="0.05" data-field="threshold" value="${esc(r.threshold ?? '')}" placeholder="from keywords (0.2 / 0.5 / 0.8)">
       <small>0 always strong, 1 almost always weak.</small></label>`;
  const outs = ROUTER_OUTS.map(o => outRow(`router.${o.key}`, o, { model: r[o.key], disabled: !editable })).join('');
  return nodeHTML('router', 'router' + (r.pin ? ' dim' : ''), 'Router', 'Classifier', body, outs, true);
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
  world.innerHTML = entryNode() + compressNode() + routerNode() + toolsNode() + models().map(modelNode).join('');
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
  const routed = new Set([...ENTRY_OUTS, ...ROUTER_OUTS].map(o => R()[o.key]).filter(Boolean));
  const firstColumn = ['entry', 'compress', 'router', 'tools'];
  const order = [...firstColumn, ...[...routed].map(m => `m:${m}`), ...models().filter(m => !routed.has(m)).map(m => `m:${m}`)];
  for (const id of order) {
    const n = byId[id];
    if (!n || positions[id]) continue;
    const col = firstColumn.includes(id) ? 0 : routed.has(id.slice(2)) ? 1 : 2;
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
  const r = R();
  const list = [
    { id: 'fixed', from: 'entry.router', to: 'compress', cls: 'fixed' },
    { id: 'fixed2', from: 'compress.router', to: 'router', cls: 'fixed', dim: !!r.pin },
  ];
  for (const o of ENTRY_OUTS) if (r[o.key]) list.push({ id: `entry.${o.key}`, from: `entry.${o.key}`, to: `m:${r[o.key]}` });
  for (const o of ROUTER_OUTS) if (r[o.key]) list.push({ id: `router.${o.key}`, from: `router.${o.key}`, to: `m:${r[o.key]}`, dim: !!r.pin });
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
    if (!w.id.startsWith('fixed')) parts.push(`<path class="hit" data-wire="${esc(w.id)}" data-hint="Click to select this line, then press Delete or Remove connection" d="${d}"/>`);
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
  if (b.dataset.act === 'reloadtools') return reloadTools();
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
  if (e.target.dataset.toggle) {
    R()[e.target.dataset.toggle] = e.target.checked;
    return changed();
  }
  if (e.target.dataset.mcp) {
    const off = new Set(R().mcpOff || []);
    if (e.target.checked) off.delete(e.target.dataset.mcp); else off.add(e.target.dataset.mcp);
    R().mcpOff = [...off];
    return changed();
  }
  const field = e.target.dataset.field;
  if (!field) return;
  const raw = e.target.value.trim();
  if (field === 'backend') {
    graph.backend = raw;
    $('backendHelp').textContent = BACKEND_HELP[raw] || '';
  } else {
    R()[field] = raw === '' ? null : Number(raw);
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
$('clearUnused').addEventListener('click', clearUnconnected);

$('tidy').addEventListener('click', () => {
  positions = {};
  try { localStorage.removeItem(LAYOUT_KEY); } catch {}
  render();
});

$('discard').addEventListener('click', () => {
  graph = clone(saved);
  selected = null;
  if (view && !graph.profiles.some(p => p.id === view)) view = '';
  drawProfiles();
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
    if (profilesChanged()) {
      note('Saving the routings…');
      info.profiles = await postJSON('api/profiles', { version: info.profiles.version, profiles: graph.profiles });
      done.push('named routings');
    }
    saved = graphFrom(info);
    graph.profiles = clone(saved.profiles); // as the server cleaned them
    drawProfiles();
    note(`Saved: ${done.join(', ')}.${restart ? ' Restart the Gateway (LiteLLM) to use the new models and fallbacks.' : ''}`, 'ok');
  } catch (err) {
    const editing = graph.profiles;
    saved = graphFrom(info); // keep whatever did save, and the edits that didn't
    graph.profiles = editing;
    note(`${done.length ? `Saved ${done.join(', ')}, but ` : ''}${err.message}`, 'err');
  }
  const message = $('msg').textContent, cls = $('msg').className;
  updateButtons();
  $('msg').textContent = message; $('msg').className = cls;
});

window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
window.addEventListener('resize', () => graph && drawWires());

// ---- named routings -----------------------------------------------------------

const VIEW_KEY = 'harness-routing-view';

function drawProfiles() {
  const sel = $('profileSel');
  sel.innerHTML = `<option value="">Default routing</option>`
    + graph.profiles.map(p => `<option value="${esc(p.id)}"${p.id === view ? ' selected' : ''}>${esc(p.name)}${saved.profiles.some(x => x.id === p.id) ? '' : ' (new)'}</option>`).join('');
  sel.value = view;
  $('profileRename').disabled = $('profileDelete').disabled = !view;
  const p = view && R();
  $('profileNote').innerHTML = p
    ? `Chats and projects pick it in their settings; other clients send the header <code>x-harness-profile: ${esc(p.id)}</code>. Models and fallbacks are shared by every routing.`
    : `What every request uses unless its chat, project or client picks another routing. ${graph.profiles.length ? '' : 'Add a routing to send some chats elsewhere, such as cheaper models or no compression.'}`;
}

function showRouting(id) {
  view = id || '';
  try { localStorage.setItem(VIEW_KEY, view); } catch {}
  selected = null;
  drawProfiles();
  changed();
}

$('profileSel').addEventListener('change', () => showRouting($('profileSel').value));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function askName(title, current) {
  const name = (prompt(title, current || '') || '').trim().slice(0, 60);
  if (!name) return null;
  const taken = graph.profiles.some(p => p.name.toLowerCase() === name.toLowerCase() && p.id !== view);
  if (!slug(name) || slug(name) === 'default' || taken) { note(`Pick another name than “${name}”.`, 'err'); return null; }
  return name;
}

$('profileNew').addEventListener('click', () => {
  const from = R();
  const name = askName(`Name the new routing. It starts as a copy of ${from === graph ? 'the default routing' : from.name}.`);
  if (!name) return;
  let id = slug(name);
  for (let n = 2; graph.profiles.some(p => p.id === id); n++) id = `${slug(name)}-${n}`;
  const copy = Object.fromEntries(ROUTE_FIELDS.map(k => [k, clone(from[k] ?? null)]));
  copy.mcpOff = copy.mcpOff || [];
  // The default's Router outputs may be unknown while the Router is down
  graph.profiles.push({ id, name, note: '', ...copy });
  showRouting(id);
  note(`Added “${name}”. Change its lines and boxes, then press Save.`);
});

$('profileRename').addEventListener('click', () => {
  const p = R();
  const name = askName('New name for this routing. Chats using it keep using it.', p.name);
  if (!name) return;
  p.name = name;
  drawProfiles();
  changed();
});

$('profileDelete').addEventListener('click', () => {
  const p = R();
  if (!confirm(`Delete the routing “${p.name}”? Chats and projects set to it go back to the default routing.\n\nNothing changes until you press Save.`)) return;
  graph.profiles = graph.profiles.filter(x => x !== p);
  showRouting('');
});

// ---- tools ----

async function reloadTools() {
  note('Reconnecting the tool servers…');
  try {
    toolInfo = await postJSON('api/tools/reload', {});
    note('Tool servers reloaded.', 'ok');
  } catch (err) {
    note(`Couldn’t reload the tool servers: ${err.message}`, 'err');
  }
  render();
}

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
  catalogPick = null;
  delete f.elements.name.dataset.suggested;
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
  $('catalog').hidden = f.elements.provider.value !== 'openrouter';
  $('addDialog').classList.toggle('narrow', $('catalog').hidden);
  $('modelHelp').hidden = $('catalog').hidden;
  if (!$('catalog').hidden) loadCatalog();
}

// ---- OpenRouter's model list, for picking a model id ----

let catalog = null;  // [{ id, name, context, inputCost, outputCost, free, tools, ... }] once loaded
let catalogLoading = null;
let catalogShown = []; // the rows on screen, in order
let catalogPick = null; // id of the model whose details are shown
const CATALOG_ROWS = 400;

function loadCatalog() {
  if (catalog || catalogLoading) return showCatalog();
  catalogLoading = getJSON('api/openrouter/models')
    .then((body) => {
      catalog = body.models || [];
      const makers = [...new Set(catalog.map(m => m.provider || m.id.split('/')[0]))].sort();
      $('catalogProvider').innerHTML = '<option value="">Every maker</option>' + makers.map(p => `<option>${esc(p)}</option>`).join('');
    })
    .catch((err) => { $('catalogNote').textContent = `${err.message} Type the id from openrouter.ai/models instead.`; })
    .finally(() => { catalogLoading = null; if (catalog) showCatalog(); });
}

// $ per million tokens, short
function perMillion(cost) {
  if (cost === null || cost === undefined) return '?';
  const m = cost * 1e6;
  return m === 0 ? '0' : m < 0.1 ? m.toFixed(3) : m < 10 ? m.toFixed(2).replace(/\.?0+$/, '') : m.toFixed(0);
}
const tokensShort = (n) => (!n ? '?' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
const vision = (m) => (m.inputs || []).includes('image');

function badges(m) {
  return [m.free && '<span class="badge free">free</span>', m.tools && '<span class="badge">tools</span>',
    m.reasoning && '<span class="badge">reasoning</span>', vision(m) && '<span class="badge">images</span>'].filter(Boolean).join('');
}

const SORTS = {
  new: (a, b) => b.created - a.created || a.id.localeCompare(b.id),
  cheap: (a, b) => ((a.inputCost ?? 1) + (a.outputCost ?? 1)) - ((b.inputCost ?? 1) + (b.outputCost ?? 1)) || a.id.localeCompare(b.id),
  context: (a, b) => (b.context || 0) - (a.context || 0) || a.id.localeCompare(b.id),
  name: (a, b) => a.name.localeCompare(b.name),
};

function showCatalog() {
  if (!catalog) return;
  const words = $('catalogSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const want = { free: $('catalogFree').checked, tools: $('catalogTools').checked, reasoning: $('catalogReasoning').checked, vision: $('catalogVision').checked };
  const maker = $('catalogProvider').value;
  catalogShown = catalog.filter(m => (!want.free || m.free) && (!want.tools || m.tools) && (!want.reasoning || m.reasoning) && (!want.vision || vision(m))
    && (!maker || (m.provider || m.id.split('/')[0]) === maker)
    && words.every(w => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)))
    .sort(SORTS[$('catalogSort').value] || SORTS.new);
  const typed = $('addForm').elements.model.value.trim().replace(/^openrouter\//, '');
  if (!catalogPick && catalog.some(m => m.id === typed)) catalogPick = typed;
  $('catalogRows').innerHTML = catalogShown.slice(0, CATALOG_ROWS).map(m => `<div class="catalog-row${m.id === catalogPick ? ' on' : ''}" role="option" aria-selected="${m.id === catalogPick}" data-id="${esc(m.id)}">
      <span class="cm"><b>${esc(m.name)}</b><code>${esc(m.id)}</code></span>
      <span>${tokensShort(m.context)}</span>
      <span>${m.free ? 'free' : `$${perMillion(m.inputCost)}`}</span>
      <span>${m.free ? 'free' : `$${perMillion(m.outputCost)}`}</span>
      <span class="badges">${badges(m)}</span></div>`).join('');
  $('catalogNote').textContent = catalogShown.length
    ? `${catalogShown.length} of ${catalog.length} models${catalogShown.length > CATALOG_ROWS ? `, the first ${CATALOG_ROWS} shown: search or filter to narrow` : ''}. Click one to see its details and fill in the model id.`
    : `None of OpenRouter's ${catalog.length} models match.`;
  showDetail();
}

function fact(label, value, hint) {
  return value === null || value === undefined || value === '' ? '' : `<dt${hint ? ` data-hint="${esc(hint)}"` : ''}>${esc(label)}</dt><dd>${value}</dd>`;
}
const usd = (cost, unit = 'M') => (cost === null || cost === undefined ? null : cost === 0 ? 'free' : unit === 'M' ? `$${perMillion(cost)} per M tokens` : `$${+cost.toPrecision(3)} ${unit}`);

function showDetail() {
  const m = catalog?.find(x => x.id === catalogPick);
  if (!m) { $('catalogDetail').innerHTML = '<p class="muted">Click a model to see its details.</p>'; return; }
  const released = m.created ? new Date(m.created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  const extra = (m.params || []).filter(p => !['tools', 'tool_choice', 'reasoning', 'include_reasoning'].includes(p));
  $('catalogDetail').innerHTML = `
    <h4>${esc(m.name)}</h4>
    <code class="id">${esc(m.id)}</code>
    <div class="badges">${badges(m)}${m.structured ? '<span class="badge">structured output</span>' : ''}${m.moderated ? '<span class="badge warn">moderated</span>' : ''}</div>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
    <dl class="facts">
      ${fact('Context', m.context ? `${m.context.toLocaleString()} tokens` : null, 'How much the model can read at once: prompt, history and tools together')}
      ${fact('Longest reply', m.maxOutput ? `${m.maxOutput.toLocaleString()} tokens` : null, 'The most tokens one reply can have')}
      ${fact('Input', usd(m.inputCost), 'Price of what you send')}
      ${fact('Output', usd(m.outputCost), 'Price of what it writes')}
      ${fact('Cached input', m.free ? null : usd(m.cacheReadCost), 'Price of input it has seen recently (repeated prompts and history)')}
      ${fact('Reasoning', m.free ? null : usd(m.reasoningCost), 'Price of thinking tokens, when billed apart from output')}
      ${fact('Images', m.free ? null : usd(m.imageCost, 'per image'))}
      ${fact('Per request', m.free || !m.requestCost ? null : usd(m.requestCost, 'per request'))}
      ${fact('Reads', esc((m.inputs || []).join(', ')))}
      ${fact('Writes', esc((m.outputs || []).join(', ')))}
      ${fact('Tokenizer', m.tokenizer ? esc(m.tokenizer) : null)}
      ${fact('Released', released)}
    </dl>
    ${extra.length ? `<div class="params" data-hint="Request settings this model accepts">${extra.map(p => `<span>${esc(p)}</span>`).join('')}</div>` : ''}
    <p class="links"><a href="https://openrouter.ai/${esc(m.id.replace(/:free$/, ''))}" target="_blank" rel="noopener">Open on openrouter.ai ↗</a>${m.huggingFace ? ` · <a href="https://huggingface.co/${esc(m.huggingFace)}" target="_blank" rel="noopener">Hugging Face ↗</a>` : ''}</p>`;
}

function pickCatalog(id) {
  const f = $('addForm');
  catalogPick = id;
  f.elements.model.value = id;
  // Suggest a Gateway name for a new box from the model's own name
  if (!f.dataset.name && (!f.elements.name.value.trim() || f.elements.name.dataset.suggested === f.elements.name.value)) {
    f.elements.name.value = f.elements.name.dataset.suggested = 'or-' + id.replace(/^[^/]+\//, '').replace(/:free$/, '-free').replace(/[^\w.-]+/g, '-');
  }
  for (const row of $('catalogRows').children) {
    row.classList.toggle('on', row.dataset.id === id);
    row.setAttribute('aria-selected', row.dataset.id === id);
  }
  showDetail();
}

$('catalogRows').addEventListener('click', (e) => {
  const row = e.target.closest('.catalog-row[data-id]');
  if (row) pickCatalog(row.dataset.id);
});
// Arrow keys move the pick through the list
$('catalogList').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const ids = catalogShown.slice(0, CATALOG_ROWS).map(m => m.id);
  const i = ids.indexOf(catalogPick);
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (!next) return;
  pickCatalog(next);
  $('catalogRows').querySelector(`[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
});
$('catalogSearch').addEventListener('input', showCatalog);
// Enter in the search box picks the top match instead of submitting the dialog
$('catalogSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (catalogShown[0]) pickCatalog(catalogShown[0].id);
});
for (const id of ['catalogFree', 'catalogTools', 'catalogReasoning', 'catalogVision', 'catalogProvider', 'catalogSort']) $(id).addEventListener('change', showCatalog);

$('addForm').elements.provider.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
$('addForm').elements.provider.addEventListener('change', showProvider);
$('addModel').addEventListener('click', () => openAdd(''));
$('addCancel').addEventListener('click', () => $('addDialog').close());
$('addClose').addEventListener('click', () => $('addDialog').close());

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
  const [status, settings, gateway, profiles, tools] = await Promise.allSettled([
    getJSON('api/status'), getJSON('api/settings'), getJSON('api/gateway'), getJSON('api/profiles'), getJSON('api/tools')]);
  const router = status.value?.components?.find(c => c.name === 'Router');
  info = {
    router: router?.ok && router.detail?.settings ? router.detail : null,
    settings: settings.value?.settings || null,
    gateway: gateway.value || null,
    gatewayError: gateway.reason?.message || null,
    profiles: profiles.value || { profiles: [], version: undefined },
  };
  toolInfo = tools.value || null;
  saved = graphFrom(info);
  graph = clone(saved);
  try { view = new URLSearchParams(location.search).get('routing') || localStorage.getItem(VIEW_KEY) || ''; } catch {}
  if (!graph.profiles.some(p => p.id === view)) view = '';
  drawProfiles();
  $('routerFile').innerHTML = info.router?.config ? `<code>${esc(info.router.config)}</code>` : 'its config file';
  if (info.gateway?.file) $('gatewayFile').textContent = info.gateway.file;
  const issues = [
    !info.settings && `Interceptor settings: ${settings.reason?.message}`,
    !info.router && 'The Router is down or has no admin endpoints, so its choices can’t be changed.',
    profiles.reason && `Named routings: ${profiles.reason.message}`,
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
      // Only requests on the routing shown light up its lines; any model box still flashes
      const mine = (e.profile || null) === (view ? R().name : null);
      let wires;
      if (!mine) wires = [];
      else if (e.reason?.startsWith('pinned in')) wires = ['fixed', 'entry.pin'];
      else if (e.reason) wires = [];
      else if (e.routerError) wires = ['fixed', e.tools ? 'entry.downTools' : 'entry.down'];
      else wires = ['fixed', 'fixed2', ...ROUTER_OUTS.filter(o => R()[o.key] === e.model).map(o => `router.${o.key}`)];
      flash([...wires, `m:${e.model}`]);
    } else if (update.type === 'response' && e.servedBy && e.servedBy !== e.model) {
      flash([['fb', e.model, e.servedBy].join('|'), `m:${e.servedBy}`]);
    }
  };
}

load().catch(err => note(err.message, 'err'));
followLive();
