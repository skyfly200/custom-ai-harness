// Routing editor: the Interceptor, the Router and the Gateway's models as
// boxes, with a line for every place a request can go. Connecting a Router or
// Interceptor output to a model sets that choice; connecting a model's "if it
// fails" dot to another model adds it to that model's fallback chain in
// config.yaml. Model boxes can be added and removed, and so can the provider
// models inside them (config.yaml model_list entries). Save writes each change
// to the file its owner reads.
//
// Named strategies (profiles) are other sets of route choices, compression and
// tools, picked per chat or project on the chat page. The picker above the
// canvas switches which strategy the Request, Compression, Router and Tools
// boxes show; model boxes belong to the Gateway and every strategy shares them.
// Fallback chains are the Gateway's too, until a strategy's chains are edited:
// then that strategy keeps its own, sent with each of its requests.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LAYOUT_KEY = 'harness-routing-layout';
const ZOOM_KEY = 'harness-routing-zoom';
const MIN_ZOOM = 0.05;   // Tidy scales the canvas down to fit, but not below this
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
  local: { label: 'Local engine (port 8000)', prefix: 'openai/', base: 'http://localhost:8000/v1', key: 'dummy-key-not-needed', example: 'local-model',
    help: 'Your llama.cpp or vLLM server (launch-local.sh). It answers with whatever model it loaded, so any name works.' },
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
  { key: 'images', label: 'Has an image', help: 'skips the Router' },
  { key: 'down', label: 'Router down', required: true },
  { key: 'downTools', label: 'Router down, with tools', required: true },
];
const ROUTER_OUTS = [
  { key: 'strong', label: 'Strong', help: 'win rate ≥ threshold', required: true },
  { key: 'strongTools', label: 'Strong, with tools', help: 'unset: strong' },
  { key: 'weak', label: 'Weak', required: true },
  { key: 'tools', label: 'Weak, with tools', help: 'unset: weak' },
  { key: 'overflow', label: 'Weak, over', tokens: true },
];

// Every output of a strategy that picks a model, extra tiers included:
// { port, node, label, model }. Tier ports are router.tier:N and router.tierTools:N,
// N being the tier's place in r.tiers.
function routeOuts(r) {
  const out = [
    ...ENTRY_OUTS.map(o => ({ port: `entry.${o.key}`, node: 'entry', label: o.label, model: r[o.key] })),
    ...ROUTER_OUTS.map(o => ({ port: `router.${o.key}`, node: 'router', label: o.label, model: r[o.key] })),
  ];
  (r.tiers || []).forEach((t, i) => {
    out.push({ port: `router.tier:${i}`, node: 'router', label: t.name || 'a tier', model: t.model });
    out.push({ port: `router.tierTools:${i}`, node: 'router', label: `${t.name || 'a tier'}, with tools`, model: t.tools });
  });
  return out;
}
function setOut(r, port, model) {
  const key = port.split('.')[1];
  const [kind, i] = key.split(':');
  if (kind === 'tier') r.tiers[Number(i)].model = model;
  else if (kind === 'tierTools') r.tiers[Number(i)].tools = model;
  else r[key] = model;
}

let info = null;     // what the server reported: router, settings, gateway
let saved = null;    // the graph as the server has it
let graph = null;    // the graph being edited
let positions = {};  // node id -> {x, y}
let selected = null; // id of the selected wire
const flashing = new Map(); // node or wire id -> time the highlight ends
let drag = null;     // a node being moved or a wire being drawn
let focus = null;    // model under the pointer: its fallback lines are drawn in full
let newKeys = 0;     // keys for provider models added on this page (saved ones use their file id)
let view = '';       // the strategy being shown: '' for the default, else a profile id
let toolInfo = null; // MCP servers (GET api/tools)

let zoom = 1;        // scale of the world (set by Tidy so every box is in view)
try { positions = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch {}
try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (z >= MIN_ZOOM && z <= 1) { zoom = z; $('world').style.transform = z === 1 ? '' : `scale(${z})`; $('world').style.transformOrigin = '0 0'; } } catch {}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const postJSON = (url, body) => getJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function note(text, cls) { $('msg').textContent = text; $('msg').className = 'note ' + (cls || ''); delete $('msg').dataset.auto; }
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
    strongTools: r.strong_model_tools ?? null,
    weak: r.weak_model ?? null,
    tools: r.weak_model_tools ?? null,
    overflow: r.weak_model_overflow ?? null,
    maxTokens: r.weak_model_max_tokens ?? null,
    caveman: settings?.caveman ?? true,
    headroom: settings?.headroom ?? true,
    contextAnchor: settings?.contextAnchor ?? true,
    mcpOff: settings?.mcpOff || [],
    images: settings?.imagesModel || null,
    tiers: clone(settings?.tiers || []),
    fallbacks: chains(gateway?.fallbacks || {}),
    deployments: (gateway?.deployments || []).map(d => ({ ...d, key: `d${d.id}` })),
    profiles: clone(info.profiles?.profiles || []),
  };
}

// The strategy being edited: the default (kept on the graph itself) or a profile
const R = () => (view && graph.profiles.find(p => p.id === view)) || graph;
const strategies = () => [graph, ...graph.profiles];
// Fallback chains: the Gateway's (on the graph) unless the strategy keeps its own
const fbOf = (r) => (r !== graph && r.fallbacks) || graph.fallbacks;
const fb = () => fbOf(R());
const allFb = () => [graph.fallbacks, ...graph.profiles.map(p => p.fallbacks).filter(Boolean)];
// The chains to edit: a strategy on its own chains starts from a copy of the Gateway's
// Editing the Gateway's own lines first gives every strategy still using them a copy, so the edit stays here
function ownFb(r = R()) {
  if (r !== graph && !r.fallbacks) r.fallbacks = clone(graph.fallbacks);
  if (r === graph) AutoRoute.freezeFallbacks(graph.profiles, graph.fallbacks);
  return fbOf(r);
}
const ROUTE_FIELDS = ['fallbacks', 'pin', 'images', 'down', 'downTools', 'threshold', 'strong', 'strongTools', 'weak', 'tools', 'overflow', 'maxTokens', 'tiers', 'caveman', 'headroom', 'contextAnchor', 'mcpOff'];
const routingName = (r) => (r === graph ? 'the default strategy' : `“${r.name}”`);

// Fallbacks without empty chains, sorted, so two can be compared as JSON
function chains(fallbacks) {
  return Object.fromEntries(Object.entries(fallbacks).filter(([, t]) => t.length).sort(([a], [b]) => a.localeCompare(b)));
}

function models() {
  const names = new Set(graph.deployments.map(d => d.name));
  for (const r of strategies()) for (const o of routeOuts(r)) if (o.model) names.add(o.model);
  for (const f of allFb()) for (const [src, targets] of Object.entries(f)) { names.add(src); targets.forEach(t => names.add(t)); }
  return [...names];
}

const routerUp = () => !!info.router?.settings;
const gatewayEditable = () => !!info.gateway && !info.gatewayError;
const served = (name) => graph.deployments.some(d => d.name === name);

function routerChanges() {
  if (!routerUp()) return {};
  const want = {
    strong_model: graph.strong, strong_model_tools: graph.strongTools, weak_model: graph.weak, weak_model_tools: graph.tools,
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
    imagesModel: graph.images, tiers: byScore(graph.tiers),
  };
  const have = info.settings || {};
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(have[k] ?? null)));
}

// Tiers as the server keeps them (highest cut-off first), so editing order doesn't count as a change
const byScore = (tiers) => [...(tiers || [])].map(t => ({ name: t.name, from: t.from, model: t.model, tools: t.tools ?? null })).sort((a, b) => b.from - a.from);
const sameProfiles = (a, b) => JSON.stringify(a.map(p => ({ ...p, tiers: byScore(p.tiers) }))) === JSON.stringify(b.map(p => ({ ...p, tiers: byScore(p.tiers) })));
const profilesChanged = () => !sameProfiles(graph.profiles, saved.profiles);

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

// What has to be fixed before saving: { text, routing, node, port }. `node` and
// `port` say where it shows on the canvas when that strategy is the one shown.
function problems() {
  const out = [];
  // The strategy on screen first, so its problems are the ones listed first
  for (const r of [R(), ...strategies().filter(x => x !== R())]) {
    const where = r === R() ? '' : ` (in ${routingName(r)})`;
    const add = (node, port, text) => out.push({ text: text.replace(/\.$/, `${where}.`), routing: r, node, port });
    for (const o of ENTRY_OUTS) if (o.required && !r[o.key]) add('entry', `entry.${o.key}`, `Connect “${o.label}” to a model.`);
    // A profile's Router outputs are its own; the default's live in the Router
    if (r === graph ? routerUp() : !r.pin) {
      for (const o of ROUTER_OUTS) if (o.required && !r[o.key]) add('router', `router.${o.key}`, `Connect the Router's “${o.label}” output to a model.`);
    }
    if (r.overflow && !(Number.isInteger(r.maxTokens) && r.maxTokens > 0)) add('router', 'router.overflow', 'Set the token limit for “Weak, over”.');
    if (r.threshold !== null && !(r.threshold >= 0 && r.threshold <= 1)) add('router', null, 'The threshold must be from 0 to 1.');
    if (r === graph ? true : !r.pin) {
      const names = new Set(['strong', 'weak']);
      (r.tiers || []).forEach((t, i) => {
        const name = (t.name || '').trim();
        if (!name) add('router', `router.tier:${i}`, 'Give every tier a name.');
        else if (names.has(name.toLowerCase())) add('router', `router.tier:${i}`, `Two tiers are called “${name}”: rename one.`);
        names.add(name.toLowerCase());
        if (!(t.from > 0 && t.from <= 1)) add('router', `router.tier:${i}`, `Tier “${name || i + 1}” needs a score from above 0 up to 1.`);
        if (!t.model) add('router', `router.tier:${i}`, `Connect tier “${name || i + 1}” to a model.`);
      });
    }
  }
  return out;
}

// Gateway fallback lines that name a model with no provider model (left over from
// models removed by hand). They can't work, so Save drops them instead of refusing.
function usableChains() {
  const keep = (n) => served(n);
  const all = chains(graph.fallbacks);
  const out = {};
  for (const [src, targets] of Object.entries(all)) {
    const t = targets.filter(keep);
    if (keep(src) && t.length) out[src] = t;
  }
  return { chains: out, dropped: Object.keys(all).length - Object.keys(out).length };
}

function connect(port, model) {
  if (port.startsWith('fail:')) {
    const src = port.slice(5);
    const chain = fb()[src] || [];
    if (src === model || chain.includes(model)) return;
    ownFb()[src] = [...chain, model];
  } else {
    setOut(R(), port, model);
  }
  changed();
}

function removeWire(id) {
  if (!id) return;
  if (id.startsWith('fb|')) {
    const [, src, target] = id.split('|');
    const own = ownFb();
    own[src] = (own[src] || []).filter(t => t !== target);
    if (!own[src].length) delete own[src];
  } else {
    setOut(R(), id, null);
  }
  selected = null;
  changed();
}

// Called once × in the title has been held down; Discard changes brings it back
function removeModel(name) {
  const uses = strategies().flatMap(r => routeOuts(r).filter(o => o.model === name)
    .map(o => `“${o.label}”${r === graph ? '' : ` in ${r.name}`}`));
  const others = strategies().filter(r => r !== R() && routeOuts(r).some(o => o.model === name));
  if (others.length && !confirm(`${name} is a model every strategy shares. Removing it also disconnects it in ${others.map(routingName).join(', ')}.\n\nRemove it anyway? Nothing changes in config.yaml until you press Save.`)) return;
  graph.deployments = graph.deployments.filter(d => d.name !== name);
  for (const f of allFb()) {
    delete f[name];
    for (const [src, targets] of Object.entries(f)) {
      const kept = targets.filter(t => t !== name);
      if (kept.length) f[src] = kept; else delete f[src];
    }
  }
  for (const r of strategies()) for (const o of routeOuts(r)) if (o.model === name) setOut(r, o.port, null);
  selected = null;
  changed();
  note(`Removed ${name}.${uses.length ? ` Connect ${uses.join(', ')} to another model before saving.` : ''} Discard changes brings it back.`, uses.length ? 'err' : '');
}

// Press and hold: × on a model box removes it only once held for HOLD_MS
const HOLD_MS = 800;
let hold = null;
function startHold(b) {
  cancelHold();
  b.style.setProperty('--hold', `${HOLD_MS}ms`);
  b.classList.add('holding');
  hold = { b, timer: setTimeout(() => { const name = b.dataset.name; hold = null; removeModel(name); }, HOLD_MS) };
}
function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.b.classList.remove('holding');
  hold = null;
}

// Models a request can get to: a route in any strategy points at it, or a
// fallback line comes to it from a model that can be got to
function reachable() {
  const seen = new Set();
  for (const r of strategies()) {
    const todo = routeOuts(r).map(o => o.model).filter(Boolean);
    const done = new Set();
    while (todo.length) {
      const m = todo.pop();
      if (done.has(m)) continue;
      done.add(m); seen.add(m);
      todo.push(...(fbOf(r)[m] || []));
    }
  }
  return seen;
}

// Models no request can get to, with or without lines of their own. Unknown
// while the Router is down, since its outputs can't be read.
function unconnected() {
  if (!routerUp()) return [];
  const reach = reachable();
  return models().filter(m => !reach.has(m));
}

function clearUnconnected() {
  const names = unconnected();
  if (!names.length) return;
  const count = graph.deployments.filter(d => names.includes(d.name)).length;
  if (!confirm(`Remove ${names.length} model${names.length === 1 ? '' : 's'} no route reaches${count ? `, with ${count === 1 ? 'its provider model' : `their ${count} provider models`} and fallback lines` : ''}?\n\n${names.join('\n')}\n\nNothing changes in config.yaml until you press Save.`)) return;
  graph.deployments = graph.deployments.filter(d => !names.includes(d.name));
  for (const f of allFb()) for (const [src, targets] of Object.entries(f)) {
    const kept = names.includes(src) ? [] : targets.filter(t => !names.includes(t));
    if (kept.length) f[src] = kept; else delete f[src];
  }
  for (const n of names) delete positions[`m:${n}`];
  selected = null;
  changed();
  note(`Removed ${names.length} model${names.length === 1 ? '' : 's'} no route reaches. Press Save to write config.yaml, then restart the Gateway.`);
}

// ---- auto-route -----------------------------------------------------------------

let autoPlan = null; // what the dialog is previewing: { r, plan }

const servedModels = () => [...new Set(graph.deployments.map(d => d.name))];
const presetHint = (id) => AutoRoute.PRESETS.find(p => p.id === id)?.hint || '';

function autoPreview() {
  const r = R();
  const preset = $('autoPreset').value || 'balanced';
  const { stats: numbers, guessed } = AutoRoute.withGuesses(servedModels(), stats.models);
  const plan = AutoRoute.preset(preset, servedModels(), numbers, r, graph.fallbacks);
  if (plan && guessed.length) plan.notes.push(`No quality rating for ${guessed.join(', ')}: guessed from ${guessed.length === servedModels().length ? 'prices and names' : 'price and name'}. Press Edit on a model box to rate it, or set ARTIFICIAL_ANALYSIS_API_KEY in .env.`);
  $('autoPresetHint').textContent = presetHint(preset);
  if (!plan) {
    if ($('autoDialog').open) $('autoDialog').close();
    note(preset === 'local' ? 'No Gateway model is named local-… so there is nothing local to use.' : 'Nothing to place: the Gateway serves no models yet. Add one with Add model.', 'err');
    return;
  }
  const after = Object.fromEntries(ROUTE_FIELDS.map(f => [f, r[f]]));
  Object.assign(after, plan.routes, { tiers: plan.tiers });
  const was = new Map(routeOuts(r).map(o => [o.port, o.model]));
  const now = routeOuts(after);
  const gone = routeOuts(r).filter(o => o.model && !now.some(x => x.port === o.port));
  const fb = Object.entries(plan.fallbacks);
  autoPlan = { r, plan };
  $('autoFor').textContent = `for ${routingName(r)}`;
  const line = (label, a, b) => `<tr class="${a === b ? 'same' : ''}"><td>${esc(label)}</td><td>${a ? esc(a) : '—'}</td><td>${b ? esc(b) : '—'}</td></tr>`;
  $('autoBody').innerHTML = `<table><thead><tr><th>Output</th><th>Now</th><th>After</th></tr></thead><tbody>
      ${now.filter(o => o.model || was.get(o.port)).map(o => line(o.label, was.get(o.port) ?? null, o.model)).join('')}
      ${gone.map(o => line(o.label, o.model, null)).join('')}</tbody></table>
    ${fb.length ? `<p class="small"><b>New fallbacks</b> (models that had none):</p><ul>${fb.map(([m, t]) => `<li>${esc(m)} → ${esc(t.join(', '))}</li>`).join('')}</ul>` : ''}
    ${plan.skipped.length ? `<p class="small"><b>Left alone, no quality rating:</b> ${plan.skipped.map(esc).join(', ')}. Press Edit on ${plan.skipped.length === 1 ? 'its box' : 'their boxes'} to rate ${plan.skipped.length === 1 ? 'it' : 'them'}, then run Auto-route again.</p>` : ''}
    ${plan.notes.map(n => `<p class="small muted">${esc(n)}</p>`).join('')}`;
  if (!$('autoDialog').open) $('autoDialog').showModal();
}

function autoApply() {
  const { r, plan } = autoPlan;
  Object.assign(r, plan.routes);
  r.tiers = clone(plan.tiers);
  for (const [m, t] of Object.entries(plan.fallbacks)) ownFb(r)[m] = t;
  $('autoDialog').close();
  const n = routeOuts(r).filter(o => o.model).length;
  tidy();
  changed();
  note(`Auto-routed ${routingName(r)}: ${n} outputs connected. Press Save to keep it, or Discard changes to undo.`, 'ok');
}
$('autoPreset').innerHTML = AutoRoute.PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
$('autoRoute').addEventListener('click', () => autoPreview());
$('autoPreset').addEventListener('change', () => autoPreview());
$('autoApply').addEventListener('click', autoApply);
$('autoCancel').addEventListener('click', () => $('autoDialog').close());
$('autoClose').addEventListener('click', () => $('autoDialog').close());

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
  const issues = problems();
  markProblems(issues);
  if (!$('toast').hidden && $('toast').dataset.kind === 'problems') showToast(issues);
  // The note follows the edits; once they are all undone it goes too
  if (d) {
    note(issues.length ? `Unsaved changes, ${issues.length} to fix before saving.` : 'Unsaved changes.', issues.length ? 'err' : '');
    $('msg').dataset.auto = '1';
  } else if ($('msg').dataset.auto) note('');
}

// Red outlines, and the problems written in the box, for the strategy shown
function markProblems(issues) {
  const world = $('world');
  for (const el of world.querySelectorAll('.node.bad, .out.bad')) el.classList.remove('bad');
  const had = world.querySelectorAll('.node .errs').length;
  for (const el of world.querySelectorAll('.node .errs')) el.remove();
  const byNode = new Map();
  for (const p of issues) {
    if (!p.node || (p.routing && p.routing !== R())) continue;
    byNode.set(p.node, [...(byNode.get(p.node) || []), p]);
  }
  for (const [id, list] of byNode) {
    const n = world.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
    if (!n) continue;
    n.classList.add('bad');
    n.querySelector('.head').insertAdjacentHTML('afterend', `<ul class="errs">${list.map(p => `<li>${esc(p.text)}</li>`).join('')}</ul>`);
    for (const p of list) if (p.port) n.querySelector(`.port[data-port="${CSS.escape(p.port)}"]`)?.closest('.out')?.classList.add('bad');
  }
  if (byNode.size || had) placeNodes();
  const bad = new Set(issues.map(p => p.routing).filter(Boolean));
  for (const opt of $('profileSel').options) {
    const r = opt.value ? graph.profiles.find(p => p.id === opt.value) : graph;
    if (r) opt.textContent = `${routingLabel(r, bad.has(r))} — ${AutoRoute.describe(r)}`;
  }
  drawWires();
}

// The toast that lists what stops a save; a problem in another strategy gets a button to show it
function showToast(issues, title = 'Can’t save yet') {
  const t = $('toast');
  if (!issues.length) { t.hidden = true; return; }
  t.dataset.kind = issues[0].routing === undefined ? 'error' : 'problems';
  t.querySelector('.toast-title').textContent = title;
  t.querySelector('ul').innerHTML = issues.map(p => {
    const other = p.routing && p.routing !== R();
    return `<li>${esc(p.text)}${other ? ` <button data-routing="${esc(p.routing === graph ? '' : p.routing.id)}">Show</button>` : ''}</li>`;
  }).join('');
  t.hidden = false;
}
$('toast').addEventListener('click', (e) => {
  if (e.target.closest('.toast-close')) { $('toast').hidden = true; return; }
  const b = e.target.closest('button[data-routing]');
  if (b) showRouting(b.dataset.routing);
});

// ---- drawing -----------------------------------------------------------------

const OUT_HINTS = {
  pin: 'Connect to send every request to one model and skip the Router. Remove the line to turn it off',
  images: 'Messages carrying a picture go here without asking the Router (not agent requests with tools, which keep their route). Connect a model that reads images. Unset: they are routed like any other',
  down: 'Where requests go when the Router doesn’t answer in time',
  downTools: 'Same, for requests that carry tools (all Claude Code requests)',
  strong: 'Hard requests: the classifier’s score is at or above the threshold',
  strongTools: 'Hard requests that carry tools (all Claude Code requests). Unset sends them to Strong. fallback-openrouter-tools is a free model that calls tools',
  weak: 'Easy requests without tools',
  tools: 'Easy requests that carry tools (all Claude Code requests). Unset sends them to Weak',
  overflow: 'Easy requests bigger than this many tokens (e.g. over a free tier’s limit). Unset means no limit',
};

function outRow(id, o, { model, disabled }) {
  const empty = !model;
  const target = empty ? `<span class="unset">${o.required ? 'not connected' : 'off'}</span>` : statShort(model);
  const tokens = o.tokens ? ` <input type="number" min="1" step="1" data-field="maxTokens" value="${esc(R().maxTokens ?? '')}" placeholder="tokens"${disabled ? ' disabled' : ''}>` : '';
  return `<div class="out${o.required ? ' required' : ''}${empty ? ' empty' : ''}" data-hint="${esc(OUT_HINTS[o.key] || '')}">
    <span class="label"><b>${esc(o.label)}</b>${o.help ? ` <span>· ${esc(o.help)}</span>` : ''} ${target}</span>${tokens}
    <span class="port out-port${disabled ? ' fixed' : ''}" data-port="${id}"></span></div>`;
}

// Model numbers (GET api/model-stats): quality 0-100, price per million tokens, speed
let stats = { models: {}, strengths: [], benchmarks: { on: false } };
const money = (n) => (n === null || n === undefined ? '?' : n === 0 ? 'free' : `$${n < 0.1 ? +n.toPrecision(2) : +n.toFixed(2)}`);
function statShort(model) {
  const s = stats.models[model];
  if (!s || (s.quality === null && s.blended === null)) return '';
  const parts = [s.quality !== null && `Q ${Math.round(s.quality)}`, s.blended !== null && money(s.blended)].filter(Boolean);
  return `<span class="stat" data-hint="${esc(model)}: quality ${s.quality ?? 'unknown'} of 100, ${money(s.blended)} per million tokens (3 in : 1 out)">${parts.join(' · ')}</span>`;
}
function statBlock(name) {
  const s = stats.models[name];
  if (!s) return '';
  const facts = [
    ['Quality', s.quality !== null ? `${s.quality}${s.qualityFrom === 'benchmark' ? '' : ' (yours)'}` : '?', 'How capable it is, 0 to 100. From Artificial Analysis’s intelligence index, or what you typed'],
    ['Coding', s.coding ?? '?', 'Coding index, 0 to 100'],
    ['Price', s.inPrice === 0 && s.outPrice === 0 ? 'free' : `${money(s.inPrice)} in · ${money(s.outPrice)} out per M`, 'Dollars per million tokens', true],
    ['Speed', s.speed !== null ? `${s.speed} tokens/s${s.ttft !== null ? `, first after ${s.ttft} s` : ''}` : '?', 'Median output tokens per second, and how long the first token takes', true],
  ];
  const tags = s.strengths.length ? `<div class="strengths">${s.strengths.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : '';
  return `<div class="sect" data-hint="What this model is good at and what it costs. Used to lay out tiers from cheap to capable">Strengths and numbers
      <button class="link" data-act="stats" data-name="${esc(name)}" data-hint="Change the numbers and strengths for ${esc(name)}">Edit</button></div>
    <dl class="stats">${facts.map(([k, v, h, wide]) => `<div${wide ? ' class="wide"' : ''} data-hint="${esc(h)}"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${tags}`;
}

const KIND_HINTS = {
  Interceptor: 'Every request from Claude Code, the chat page or other clients arrives here first',
  Classifier: 'Scores how hard each request is and picks a model from the outputs below',
  Model: 'A name the Gateway (LiteLLM) serves. Drag the title to move the box',
  Transforms: 'What the Interceptor does to each request before it goes on, to save tokens',
  MCP: 'Tool servers from mcp-servers.json that Bright Chat offers the model',
};

function nodeHTML(id, cls, title, kind, body, outs, hasIn, extra = '') {
  return `<div class="node ${cls}" data-id="${esc(id)}"${cls.split(' ')[0] === 'model' ? ` data-model="${esc(title)}"` : ''}>
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
    + `<small>${on ? `${on} of 3 on.` : 'Off: requests go on unchanged.'} Runs on every request on this strategy, pinned ones too.</small>`;
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
  const body = `<ul class="mcp">${rows.join('') || `<li class="muted small">${toolInfo ? `No servers. <a href="tools.html">Add one</a> on the Tools page.` : 'Couldn’t read the tool servers.'}</li>`}</ul>
    <small>Ticked servers are offered to the model in Bright Chat chats on this strategy (each chat can still turn them off in Options). Claude Code brings its own tools. <a href="tools.html">Add or edit servers</a>.</small>
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
      : '<div class="warn">The Router is down: requests on this strategy go to “Router down” until it is back.</div>')
    + `<label data-hint="How requests are scored. Every strategy shares it. Its other settings (address, key, timeout) are on the Settings page">Classifier${view ? ' · shared' : ''}<select data-field="backend"${up ? '' : ' disabled'}>${backends.map(b => `<option${b === graph.backend ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>
       <small id="backendHelp">${esc(BACKEND_HELP[graph.backend] || '')}</small></label>
     <label data-hint="Requests scoring at or above this go to Strong. Empty uses the keyword rule">Threshold<input type="number" min="0" max="1" step="0.05" data-field="threshold" value="${esc(r.threshold ?? '')}" placeholder="from keywords (0.2 / 0.5 / 0.8)">
       <small>0 always strong, 1 almost always weak.</small></label>`;
  const outs = ladder(r, editable);
  return nodeHTML('router', 'router' + (r.pin ? ' dim' : ''), 'Router', 'Classifier', body, outs, true);
}

// The Router's outputs as a ladder, hardest first: extra tiers sit above
// Strong, between Strong and Weak, or (never) below Weak, by their cut-off
function ladder(r, editable) {
  const cut = r.threshold ?? 0.5; // the keyword rule's middle value when no threshold is set
  const tiers = (r.tiers || []).map((t, i) => ({ t, i })).sort((a, b) => (b.t.from ?? 0) - (a.t.from ?? 0));
  const above = tiers.filter(x => (x.t.from ?? 0) >= cut);
  const below = tiers.filter(x => (x.t.from ?? 0) < cut);
  const out = (key) => { const o = ROUTER_OUTS.find(x => x.key === key); return outRow(`router.${key}`, o, { model: r[key], disabled: !editable }); };
  const tierRows = ({ t, i }) => `<div class="tier" data-hint="An extra tier: requests scoring at or above its cut-off (and below the next tier up) go to its model">
      <input class="tier-name" data-tier="${i}" data-tf="name" value="${esc(t.name)}" placeholder="Tier name" aria-label="Tier name">
      <label>from <input type="number" min="0.01" max="1" step="0.05" data-tier="${i}" data-tf="from" value="${esc(t.from ?? '')}" aria-label="Lowest score for this tier"></label>
      <button data-act="untier" data-i="${i}" aria-label="Remove tier ${esc(t.name)}" data-hint="Remove this tier; its requests go back to Strong or Weak">×</button></div>`
    + outRow(`router.tier:${i}`, { key: 'tier', label: t.name || 'Tier', help: `score ≥ ${t.from ?? '?'}`, required: true }, { model: t.model })
    + outRow(`router.tierTools:${i}`, { key: 'tierTools', label: `${t.name || 'Tier'}, with tools`, help: `unset: ${t.name || 'tier'}` }, { model: t.tools });
  // Higher rungs should be at least as good: say when the numbers disagree
  const rungs = [...above.map(x => [x.t.name, x.t.model]), ['Strong', r.strong], ...below.map(x => [x.t.name, x.t.model]), ['Weak', r.weak]]
    .filter(([, m]) => m && stats.models[m]?.quality != null);
  const upsideDown = [];
  for (let i = 0; i + 1 < rungs.length; i++) {
    const [hi, hm] = rungs[i], [lo, lm] = rungs[i + 1];
    if (stats.models[hm].quality < stats.models[lm].quality) upsideDown.push(`“${hi}” (${hm}, quality ${Math.round(stats.models[hm].quality)}) is below “${lo}” (${lm}, ${Math.round(stats.models[lm].quality)})`);
  }
  const warn = upsideDown.length ? `<div class="warn ladder-warn" data-hint="Harder requests go to the higher rungs, so their models should score higher. Swap the lines, or check the numbers in the model boxes">${esc(upsideDown.join('; '))}.</div>` : '';
  const add = `<button class="add-dep add-tier" data-act="addtier" data-hint="Add a tier with its own model and score cut-off. Put one above the threshold for the hardest requests, or below it for middling ones">+ Add tier</button>`;
  return above.map(tierRows).join('') + out('strong') + out('strongTools') + below.map(tierRows).join('')
    + out('weak') + out('tools') + out('overflow') + warn + add;
}

function deploymentRow(d, only) {
  const id = d.model || '(no model id)';
  const where = [d.model, d.api_base && `at ${d.api_base}`, d.api_key && `key: ${d.api_key}`].filter(Boolean).join('\n');
  const remove = gatewayEditable()
    ? `<button data-act="undeploy" data-key="${esc(d.key)}" data-hint="${only ? 'The last provider model can’t be removed on its own: hold × in the box title to remove the whole box' : `Stop sending ${esc(d.name)} requests to this model`}"${only ? ' disabled' : ''}>×</button>`
    : '';
  return `<li${d.id === undefined ? ' class="new"' : ''}><span class="tag" data-hint="${esc(where)}">${esc(providerOf(d))}</span>
    <span class="name" data-hint="${esc(where)}">${esc(id.replace(/^(openrouter|groq|openai)\//, ''))}</span>${remove}</li>`;
}

function modelNode(name) {
  const chain = fb()[name] || [];
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
  const close = editable ? `<button class="close hold" data-act="unmodel" data-name="${esc(name)}" aria-label="Remove ${esc(name)} (press and hold)" data-hint="Press and hold to remove ${esc(name)} from the Gateway, with its provider models and fallback lines">×</button>` : '';
  const lost = routerUp() && !reachable().has(name);
  const why = lost ? '<div class="unreach" data-hint="No route in any strategy leads here, directly or through fallbacks. Clear unconnected models removes it">No route reaches it.</div>' : '';
  return nodeHTML(`m:${name}`, lost ? 'model unreached' : 'model', name, 'Model', why + statBlock(name) + servedBy + list, outs, true, close);
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
  const routed = new Set(routeOuts(R()).map(o => o.model).filter(Boolean));
  const firstColumn = ['entry', 'compress', 'router', 'tools'];
  const order = [...firstColumn, ...[...routed].map(m => `m:${m}`), ...models().filter(m => !routed.has(m)).map(m => `m:${m}`)];
  for (const id of order) {
    const n = byId[id];
    if (!n || positions[id]) continue;
    const col = firstColumn.includes(id) ? 0 : routed.has(id.slice(2)) ? 1 : 2;
    positions[id] = { x: columns[col], y: next[col] };
    next[col] += n.offsetHeight + 24;
  }
  // A box that grew (an error written in it, a longer fallback list) moves the
  // boxes it would cover down while it is that size; their saved spots stay
  let w = 0, h = 0;
  const shown = [];
  for (const n of [...nodes].sort((a, b) => positions[a.dataset.id].y - positions[b.dataset.id].y)) {
    const p = positions[n.dataset.id];
    const nw = n.offsetWidth, nh = n.offsetHeight;
    let top = p.y;
    for (let moved = true; moved;) {
      moved = false;
      for (const q of shown) {
        if (p.x < q.x + q.w && q.x < p.x + nw && top < q.y + q.h + 8 && q.y < top + nh) { top = q.y + q.h + 12; moved = true; }
      }
    }
    shown.push({ x: p.x, y: top, w: nw, h: nh });
    n.style.left = p.x + 'px';
    n.style.top = top + 'px';
    w = Math.max(w, p.x + nw);
    h = Math.max(h, top + nh);
  }
  sizeWorld(w + 200, h + 200);
}

// The world's box is its unscaled size; negative margins take back the space the
// scale removed, so the canvas scrolls over what is drawn and no more
function sizeWorld(w, h) {
  const el = $('world');
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.marginRight = -Math.round(w * (1 - zoom)) + 'px';
  el.style.marginBottom = -Math.round(h * (1 - zoom)) + 'px';
}

// Tidy layout: columns that follow the lines of the strategy shown, left to
// right. The Interceptor, Compression, Router and Tools boxes make the first
// column and every model a route goes to makes the second, so no route line
// passes a column. A model only fallbacks lead to sits one column right of the
// furthest box with a fallback line to it (loops are cut where they turn back). A line that skips a column
// keeps a gap open in each column it passes, and every column is ordered and
// spaced so its boxes sit level with the lines coming in, which keeps lines
// from crossing each other or running behind boxes.
function tidy() {
  const GAP = 24, SKIP = 30, LEFT = 30, TOP = 30, SPACE = 120;
  const world = $('world');
  const box = (id) => world.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  const r = R();

  // Lines: from an output dot (and the box it is on) to a model
  const lines = [];
  for (const o of routeOuts(r)) if (o.model) lines.push({ port: o.port, from: o.node, to: o.model });
  for (const [src, targets] of Object.entries(fb())) for (const t of targets) lines.push({ port: `fail:${src}`, from: src, to: t });

  // Fallback lines that close a loop are left out of the columns
  const all = models();
  const routed = [...new Set(lines.filter(l => l.from === 'entry' || l.from === 'router').map(l => l.to))];
  const state = {}; const order = []; const back = new Set();
  const visit = (m) => {
    state[m] = 'open';
    for (const t of fb()[m] || []) {
      if (state[t] === 'open') back.add(`${m}|${t}`);
      else if (!state[t]) visit(t);
    }
    state[m] = 'done';
    order.unshift(m);
  };
  for (const m of [...routed, ...all]) if (!state[m]) visit(m);
  // Models nothing on this strategy leads to go in columns of their own on the right
  const reach = new Set(); const todo = [...routed];
  while (todo.length) { const m = todo.pop(); if (!reach.has(m)) { reach.add(m); todo.push(...(fb()[m] || [])); } }
  const column = Object.fromEntries(all.map(m => [m, 1]));
  const direct = new Set(routed);
  const spread = (group) => {
    for (const m of order) if (group.has(m)) for (const t of fb()[m] || []) {
      if (group.has(t) && !direct.has(t) && !back.has(`${m}|${t}`)) column[t] = Math.max(column[t], column[m] + 1);
    }
  };
  spread(reach);
  const last = Math.max(1, ...[...reach].map(m => column[m]));
  const rest = new Set(all.filter(m => !reach.has(m)));
  for (const m of rest) column[m] = last + 1;
  spread(rest);

  // First column, top to bottom, then what is known about each box's dots
  positions = {};
  let y = TOP;
  for (const id of ['entry', 'compress', 'router', 'tools']) { positions[id] = { x: LEFT, y }; y += (box(id)?.offsetHeight || 0) + GAP; }
  const offset = (el, n) => { const a = el.getBoundingClientRect(), b = n.getBoundingClientRect(); return (a.top - b.top + a.height / 2) / zoom; };
  const portY = {};   // output dot -> y below its box's top
  const inY = {};     // model box -> y of its input dot below its top
  for (const n of world.querySelectorAll('.node')) {
    for (const p of n.querySelectorAll('.out-port')) portY[p.dataset.port] = offset(p, n);
    const i = n.querySelector('.in-port');
    if (i) inY[n.dataset.id] = offset(i, n);
  }

  // Each column holds its boxes and a gap for every line passing through it
  const cols = [];
  const item = (c, it) => { (cols[c] ||= []).push(it); return it; };
  const items = Object.fromEntries(all.map(m => [m, item(column[m], { id: `m:${m}`, h: box(`m:${m}`)?.offsetHeight || 60, w: box(`m:${m}`)?.offsetWidth || 270, ins: [] })]));
  for (const l of lines) {
    const startCol = l.from === 'entry' || l.from === 'router' ? 0 : column[l.from];
    // Only lines going right place boxes; ones turning back are drawn but don't pull
    if (column[l.to] <= startCol) continue;
    // Where the line leaves: a dot in the first column, or a dot on a model box placed earlier
    let source = l.from === 'entry' || l.from === 'router'
      ? { y: () => positions[l.from].y + portY[l.port] }
      : { y: () => positions[`m:${l.from}`].y + portY[l.port] };
    for (let c = startCol + 1; c < column[l.to]; c++) {
      const gap = item(c, { id: null, h: SKIP, w: 0, ins: [source] });
      source = { y: () => gap.y + SKIP / 2 };
    }
    items[l.to].ins.push(source);
  }

  // Place column by column: in the order of the lines coming in, each box as
  // close to level with them as the boxes above it allow
  let x = LEFT + Math.max(...['entry', 'compress', 'router', 'tools'].map(id => box(id)?.offsetWidth || 270)) + SPACE;
  for (let c = 1; c < cols.length; c++) {
    const col = cols[c] || [];
    col.forEach((it, i) => {
      it.at = i;
      it.from = it.ins.map(s => s.y());
      it.want = it.from.length ? it.from.reduce((sum, y) => sum + y, 0) / it.from.length : Infinity;
    });
    col.sort((a, b) => a.want - b.want || a.at - b.at);
    leastCrossings(col);
    let next = TOP;
    for (const it of col) {
      const dot = it.id ? (inY[it.id] ?? 19) : SKIP / 2;
      it.y = Math.max(next, Number.isFinite(it.want) ? it.want - dot : next);
      if (it.id) positions[it.id] = { x, y: Math.round(it.y) };
      next = it.y + it.h + (it.id ? GAP : 6);
    }
    if (col.length) x += Math.max(0, ...col.map(it => it.w)) + SPACE;
  }
  placeNodes();
  fitView();
  drawWires();
}

// Scales the world so every box is inside the canvas (never above 100%, never
// below MIN_ZOOM, where text stops being readable and the canvas scrolls
// instead), and scrolls to the top left. Positions stay in unscaled units.
function setZoom(z) {
  zoom = z;
  $('world').style.transform = z === 1 ? '' : `scale(${z})`;
  $('world').style.transformOrigin = '0 0';
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch {}
}
function fitView() {
  const canvas = $('canvas');
  setZoom(1);
  let w = 0, h = 0;
  for (const n of $('world').querySelectorAll('.node')) { w = Math.max(w, n.offsetLeft + n.offsetWidth); h = Math.max(h, n.offsetTop + n.offsetHeight); }
  const pad = 30;
  setZoom(Fit.fitZoom(w, h, canvas.clientWidth, canvas.clientHeight, { pad, min: MIN_ZOOM }));
  // The scrollable area follows the scaled boxes, not the padding placeNodes adds
  sizeWorld(w + pad, h + pad);
  canvas.scrollLeft = 0;
  canvas.scrollTop = 0;
}

// Reorders a column, in place, so the fewest lines coming into it cross: every
// order is tried for a short column (the level order wins a tie), longer ones
// keep the level order. Two lines cross when their boxes are in the opposite
// order to the dots they leave from.
function leastCrossings(col) {
  const n = col.length;
  if (n < 2 || n > 7) return;
  const pair = col.map(a => col.map(b => a === b ? 0 : a.from.reduce((sum, ya) => sum + b.from.filter(yb => yb < ya).length, 0)));
  // pair[i][j]: crossings when i is above j
  let best = null, bestCost = Infinity;
  const idx = col.map((_, i) => i);
  const cost = (order) => { let c = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) c += pair[order[i]][order[j]]; return c; };
  const walk = (k) => {
    if (k === n) { const c = cost(idx); if (c < bestCost) { bestCost = c; best = [...idx]; } return; }
    for (let i = k; i < n; i++) {
      [idx[k], idx[i]] = [idx[i], idx[k]];
      walk(k + 1);
      [idx[k], idx[i]] = [idx[i], idx[k]];
    }
  };
  walk(0);
  const items = best.map(i => col[i]);
  col.splice(0, n, ...items);
}

function wireList() {
  const r = R();
  const list = [
    { id: 'fixed', from: 'entry.router', to: 'compress', cls: 'fixed' },
    { id: 'fixed2', from: 'compress.router', to: 'router', cls: 'fixed', dim: !!r.pin },
  ];
  for (const o of routeOuts(r)) if (o.model) list.push({ id: o.port, from: o.port, to: `m:${o.model}`, dim: o.node === 'router' && !!r.pin });
  for (const [src, targets] of Object.entries(fb())) {
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
  return { x: (r.left - w.left + r.width / 2) / zoom, y: (r.top - w.top + r.height / 2) / zoom };
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
  return { x: (e.clientX - w.left) / zoom, y: (e.clientY - w.top) / zoom };
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
  const holdBtn = e.target.closest('button.hold');
  if (holdBtn && e.button === 0) {
    e.preventDefault();
    startHold(holdBtn);
    return;
  }
  const head = e.target.closest('.head');
  if (head && !e.target.closest('button')) {
    e.preventDefault();
    const node = head.parentElement;
    head.setPointerCapture(e.pointerId);
    drag = { kind: 'move', node, start: worldPoint(e), from: { x: node.offsetLeft, y: node.offsetTop } };
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
// Letting go, or sliding off ×, before the time is up keeps the model
document.addEventListener('pointerup', cancelHold);
document.addEventListener('pointercancel', cancelHold);
$('world').addEventListener('pointerout', (e) => { if (hold && e.target.closest('button.hold') === hold.b) cancelHold(); });
// The same with the keyboard: hold Enter or Space on a focused ×
$('world').addEventListener('keydown', (e) => {
  const b = e.target.closest?.('button.hold');
  if (!b || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  if (!e.repeat) startHold(b);
});
$('world').addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') cancelHold(); });

$('world').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'unmodel') return;
  if (b.dataset.act === 'undeploy') return removeDeployment(b.dataset.key);
  if (b.dataset.act === 'adddep') return openAdd(b.dataset.name);
  if (b.dataset.act === 'reloadtools') return reloadTools();
  if (b.dataset.act === 'addtier') return addTier();
  if (b.dataset.act === 'untier') { R().tiers.splice(Number(b.dataset.i), 1); selected = null; return changed(); }
  if (b.dataset.act === 'stats') return openStats(b.dataset.name);
  const own = ownFb();
  const chain = [...own[b.dataset.src]];
  const i = Number(b.dataset.i);
  if (b.dataset.act === 'del') chain.splice(i, 1);
  else {
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    [chain[i], chain[j]] = [chain[j], chain[i]];
  }
  if (chain.length) own[b.dataset.src] = chain; else delete own[b.dataset.src];
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
  if (e.target.dataset.tier !== undefined) {
    const t = R().tiers[Number(e.target.dataset.tier)];
    const raw = e.target.value;
    if (e.target.dataset.tf === 'name') t.name = raw.trim();
    else t.from = raw.trim() === '' ? null : Number(raw);
    return updateButtons();
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

// A tier's cut-off or name, once typed, moves it to its place on the ladder
$('world').addEventListener('change', (e) => { if (e.target.dataset.tier !== undefined) changed(); });

function addTier() {
  const r = R();
  r.tiers = r.tiers || [];
  const cut = r.threshold ?? 0.5;
  const top = !r.tiers.some(t => t.from >= cut);
  const from = Math.round((top ? cut + (1 - cut) / 2 : cut / 2) * 20) / 20 || 0.05;
  const taken = new Set(['strong', 'weak', ...r.tiers.map(t => (t.name || '').toLowerCase())]);
  let name = top ? 'Frontier' : 'Mid';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Tier ${n}`;
  r.tiers.push({ name, from: Math.min(1, from), model: null, tools: null });
  changed();
  note(`Added the tier “${name}”. Drag its dot to a model and set its score, then press Save.`);
}

// ---- model numbers -------------------------------------------------------------

async function loadStats() {
  try { stats = await getJSON('api/model-stats'); } catch { stats = { models: {}, strengths: [], benchmarks: { on: false } }; }
  const b = stats.benchmarks || {};
  $('benchNote').innerHTML = b.on
    ? (b.error ? `Benchmarks couldn’t be read: ${esc(b.error)}.` : `Quality, coding and speed numbers: <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a> (${b.count} models).`)
    : 'Set <code>ARTIFICIAL_ANALYSIS_API_KEY</code> in .env to fill in quality and speed from benchmarks, or type them in each model’s Edit.';
}

function openStats(name) {
  const s = stats.models[name] || { strengths: [] };
  const f = $('statsForm');
  $('statsTitle').textContent = name;
  f.quality.value = s.qualityFrom === 'you' ? s.quality : '';
  f.quality.placeholder = s.qualityFrom === 'benchmark' ? `${s.quality} from the benchmark` : 'unknown';
  f.coding.value = '';
  f.coding.placeholder = s.coding !== null && s.coding !== undefined ? String(s.coding) : 'unknown';
  f.speed.value = '';
  f.speed.placeholder = s.speed !== null && s.speed !== undefined ? String(s.speed) : 'unknown';
  const all = [...new Set([...(stats.strengths || []), ...s.strengths])];
  $('statsTags').innerHTML = all.map(t => `<label class="chip-check"><input type="checkbox" value="${esc(t)}"${s.strengths.includes(t) ? ' checked' : ''}> ${esc(t)}</label>`).join('');
  f.more.value = '';
  const list = stats.benchmarks?.models || [];
  $('benchField').hidden = !list.length;
  f.benchmark.innerHTML = `<option value="">${s.benchmark ? `Matched: ${esc(s.benchmark.name)}` : 'No match found'}</option>`
    + list.map(m => `<option value="${esc(m.slug)}">${esc(m.name)}${m.creator ? ` · ${esc(m.creator)}` : ''}</option>`).join('');
  $('statsMsg').textContent = '';
  $('statsDialog').dataset.name = name;
  $('statsDialog').showModal();
}

async function saveStats(values) {
  const name = $('statsDialog').dataset.name;
  try {
    await postJSON('api/model-stats', { name, values });
    $('statsDialog').close();
    await loadStats();
    render();
    note(`Saved the numbers for ${name}.`, 'ok');
  } catch (err) {
    $('statsMsg').textContent = err.message;
  }
}

$('statsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const s = stats.models[$('statsDialog').dataset.name] || {};
  const tags = [...$('statsTags').querySelectorAll('input:checked')].map(i => i.value)
    .concat(f.more.value.split(',').map(t => t.trim()).filter(Boolean));
  const derived = JSON.stringify([...(s.strengths || [])].sort()) === JSON.stringify([...tags].sort()) && !s.edited;
  saveStats({
    quality: f.quality.value, coding: f.coding.value, speed: f.speed.value,
    strengths: derived ? null : tags, benchmark: f.benchmark.value,
  });
});
$('statsReset').addEventListener('click', () => saveStats({}));
$('statsCancel').addEventListener('click', () => $('statsDialog').close());

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.target.closest('input, select, textarea')) {
    e.preventDefault();
    removeWire(selected);
  }
});
$('remove').addEventListener('click', () => removeWire(selected));
$('clearUnused').addEventListener('click', clearUnconnected);

$('tidy').addEventListener('click', () => {
  tidy();
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions)); } catch {}
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
  if (issues.length) {
    showToast(issues);
    const first = $('world').querySelector('.node.bad');
    first?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return;
  }
  $('toast').hidden = true;
  $('save').disabled = $('discard').disabled = true;
  const done = [];
  let restart = false;
  try {
    // The Gateway first: the Router may name a model that is only added here
    if (gatewayChanged()) {
      note('Writing config.yaml…');
      const { chains: usable, dropped } = usableChains();
      info.gateway = await postJSON('api/gateway', { version: info.gateway.version, ...deploymentChanges(), fallbacks: usable });
      graph.deployments = graphFrom(info).deployments;
      graph.fallbacks = clone(graphFrom(info).fallbacks);
      done.push(`Gateway models and fallbacks${dropped ? ` (dropped ${dropped} fallback line${dropped === 1 ? '' : 's'} for models with no provider model)` : ''}`);
      loadStats().then(render);
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
      note('Saving the strategies…');
      info.profiles = await postJSON('api/profiles', { version: info.profiles.version, profiles: graph.profiles });
      done.push('named strategies');
    }
    saved = graphFrom(info);
    graph.profiles = clone(saved.profiles); // as the server cleaned them
    graph.tiers = clone(saved.tiers);
    drawProfiles();
    note(`Saved: ${done.join(', ')}.${restart ? ' Restart the Gateway (LiteLLM) to use the new models and fallbacks.' : ''}`, 'ok');
  } catch (err) {
    const editing = graph.profiles;
    saved = graphFrom(info); // keep whatever did save, and the edits that didn't
    graph.profiles = editing;
    note(`${done.length ? `Saved ${done.join(', ')}, but ` : ''}${err.message}`, 'err');
    showToast([{ text: $('msg').textContent }], 'Couldn’t save');
  }
  const message = $('msg').textContent, cls = $('msg').className;
  updateButtons();
  $('msg').textContent = message; $('msg').className = cls;
});

window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
window.addEventListener('resize', () => graph && drawWires());

// ---- named strategies -----------------------------------------------------------

const VIEW_KEY = 'harness-routing-view';
const routingLabel = (r, bad) => (r === graph ? 'Default strategy' : r.name + (saved.profiles.some(x => x.id === r.id) ? '' : ' (new)')) + (bad ? ' · needs fixing' : '');

function drawProfiles() {
  const sel = $('profileSel');
  sel.innerHTML = `<option value="">${esc(routingLabel(graph))} — ${esc(AutoRoute.describe(graph))}</option>`
    + graph.profiles.map(p => `<option value="${esc(p.id)}"${p.id === view ? ' selected' : ''}>${esc(routingLabel(p))} — ${esc(AutoRoute.describe(p))}</option>`).join('');
  sel.value = view;
  $('profileRename').disabled = $('profileDelete').disabled = !view;
  $('profileFb').hidden = !(view && R().fallbacks);
  const p = view && R();
  $('profileNote').innerHTML = p
    ? `Chats and projects pick it in their settings; other clients send the header <code>x-harness-profile: ${esc(p.id)}</code>. Only the model boxes (and their provider settings) are shared by every strategy; routes, tiers and compression are this strategy’s own. ${p.fallbacks ? 'This strategy keeps its own fallback lines.' : 'Its fallback lines are the Gateway’s until you change one here.'}`
    : `Used unless a chat, project or client picks another.${graph.profiles.length ? '' : ' Add one to send some chats elsewhere.'}`;
  drawAuto();
}

// Auto's rules and description for the strategy shown (the default has none: it is Auto's fallback)
const emptyRules = () => ({ words: [], tools: 'any', clients: [], minTokens: null, maxTokens: null });
const csv = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
function drawAuto() {
  $('autoBox').hidden = !view;
  const p = view && R();
  if (!p) return;
  const r = p.rules || (p.rules = emptyRules());
  $('autoDesc').value = p.description || '';
  $('autoWords').value = r.words.join(', ');
  $('autoTools').value = r.tools;
  $('autoClients').value = r.clients.join(', ');
  $('autoMin').value = r.minTokens ?? '';
  $('autoMax').value = r.maxTokens ?? '';
}
function readAuto() {
  const p = R();
  if (!view || !p) return;
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  p.description = $('autoDesc').value;
  p.rules = { words: csv($('autoWords').value), tools: $('autoTools').value, clients: csv($('autoClients').value), minTokens: num('autoMin'), maxTokens: num('autoMax') };
  updateButtons();
}
for (const id of ['autoDesc', 'autoWords', 'autoTools', 'autoClients', 'autoMin', 'autoMax']) $(id).addEventListener('input', readAuto);

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

function openNew() {
  const from = R();
  $('newStart').innerHTML = `<option value="copy">A copy of ${esc(from === graph ? 'the default strategy' : from.name)}</option>`
    + AutoRoute.PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  // Different from the start is the point of a second strategy, so a preset is offered first once there is one
  if (graph.profiles.length || from !== graph) $('newStart').value = 'balanced';
  $('newName').value = '';
  newHint();
  $('newDialog').showModal();
  $('newName').focus();
}
function newHint() {
  const v = $('newStart').value;
  $('newHint').textContent = v === 'copy' ? 'Starts with the same lines, so it behaves the same until you change something.' : presetHint(v);
}

function createStrategy(name, start) {
  const from = R();
  let id = slug(name);
  for (let n = 2; graph.profiles.some(p => p.id === id); n++) id = `${slug(name)}-${n}`;
  const copy = Object.fromEntries(ROUTE_FIELDS.map(k => [k, clone(from[k] ?? null)]));
  copy.fallbacks = clone(from.fallbacks || graph.fallbacks); // its own lines, so editing either strategy never changes the other
  copy.mcpOff = copy.mcpOff || [];
  // The default's Router outputs may be unknown while the Router is down
  const p = { id, name, note: '', description: '', rules: emptyRules(), ...copy };
  let how = 'a copy';
  if (start !== 'copy') {
    const plan = AutoRoute.preset(start, servedModels(), stats.models, { ...p, down: null, downTools: null }, graph.fallbacks);
    if (plan) {
      Object.assign(p, { strongTools: null, tools: null, overflow: null, maxTokens: null, pin: null, threshold: null }, plan.routes, { tiers: clone(plan.tiers) });
      p.fallbacks = Object.assign({}, from.fallbacks || graph.fallbacks, plan.fallbacks);
      how = AutoRoute.PRESETS.find(x => x.id === start).label;
    } else how = 'a copy, since there was nothing to place';
  }
  graph.profiles.push(p);
  showRouting(id);
  tidy();
  changed();
  note(`Added “${name}” as ${how}. Change its lines and boxes, then press Save.`);
}

$('profileNew').addEventListener('click', openNew);
$('newStart').addEventListener('change', newHint);
$('newCancel').addEventListener('click', () => $('newDialog').close());
$('newForm').addEventListener('submit', () => {
  const name = $('newName').value.trim();
  const taken = graph.profiles.some(p => p.name.toLowerCase() === name.toLowerCase());
  if (!name || !slug(name) || slug(name) === 'default' || slug(name) === 'auto' || taken) { note(`Pick another name than “${name}”.`, 'err'); return; }
  createStrategy(name, $('newStart').value);
});

// Every strategy side by side
function openCompare() {
  const all = strategies();
  const rows = new Map(); // label -> [model per strategy]
  all.forEach((r, i) => {
    for (const o of routeOuts(r)) {
      if (!rows.has(o.label)) rows.set(o.label, all.map(() => null));
      rows.get(o.label)[i] = o.model || null;
    }
  });
  const extra = [
    ['Threshold', (r) => (r.threshold == null ? 'Router’s' : String(r.threshold))],
    ['Fallback lines', (r) => (r.fallbacks ? `${Object.keys(r.fallbacks).length} own` : 'Gateway’s')],
  ];
  const cell = (v, vals) => `<td class="${new Set(vals).size > 1 ? 'differs' : ''}">${v ? esc(v) : '—'}</td>`;
  const head = all.map((r, i) => `<th><button type="button" class="link" data-show="${i ? esc(r.id) : ''}">${esc(r === graph ? 'Default' : r.name)}</button></th>`).join('');
  const body = [...rows].filter(([, v]) => v.some(Boolean)).map(([label, vals]) => `<tr><td>${esc(label)}</td>${vals.map(v => cell(v, vals)).join('')}</tr>`).join('')
    + extra.map(([label, f]) => { const vals = all.map(f); return `<tr><td>${label}</td>${vals.map(v => cell(v, vals)).join('')}</tr>`; }).join('');
  const same = all.length > 1 && all.every((r) => AutoRoute.describe(r) === AutoRoute.describe(all[0]));
  $('compareBody').innerHTML = `${same ? '<p class="small"><b>These strategies all use the same models.</b> Press New strategy and start from Cheapest or Best quality, or use Auto-route and pick a Style, to make them differ.</p>' : ''}
    <table class="compare"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $('compareDialog').showModal();
}
$('profileCompare').addEventListener('click', openCompare);
$('compareClose').addEventListener('click', () => $('compareDialog').close());
$('compareBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-show]');
  if (!b) return;
  $('compareDialog').close();
  showRouting(b.dataset.show);
});

$('profileFb').addEventListener('click', () => {
  const p = R();
  if (!p.fallbacks || !confirm(`Drop the fallback lines kept for “${p.name}” and use the Gateway's again?\n\nNothing changes until you press Save.`)) return;
  p.fallbacks = null;
  selected = null;
  drawProfiles();
  changed();
});

$('profileRename').addEventListener('click', () => {
  const p = R();
  const name = askName('New name for this strategy. Chats using it keep using it.', p.name);
  if (!name) return;
  p.name = name;
  drawProfiles();
  changed();
});

$('profileDelete').addEventListener('click', () => {
  const p = R();
  if (!confirm(`Delete the strategy “${p.name}”? Chats and projects set to it go back to the default strategy.\n\nNothing changes until you press Save.`)) return;
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
let bench = { on: false, error: null, count: 0, models: {} }; // GET api/openrouter/benchmarks
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
  getJSON('api/openrouter/benchmarks')
    .then((b) => { bench = b; $('catalogRated').disabled = !Object.keys(b.models || {}).length; showCatalog(); })
    .catch(() => {});
}

const score = (m, k) => bench.models?.[m.id]?.[k] ?? null;
const pt = (v) => (v === null || v === undefined ? '<span class="na">–</span>' : Math.round(v));

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
    m.reasoning && '<span class="badge">reasoning</span>', m.batch && '<span class="badge" data-hint="Batch API: about half price, results within 24 hours">batch</span>', vision(m) && '<span class="badge">images</span>'].filter(Boolean).join('');
}

const SORTS = {
  new: (a, b) => b.created - a.created || a.id.localeCompare(b.id),
  cheap: (a, b) => ((a.inputCost ?? 1) + (a.outputCost ?? 1)) - ((b.inputCost ?? 1) + (b.outputCost ?? 1)) || a.id.localeCompare(b.id),
  context: (a, b) => (b.context || 0) - (a.context || 0) || a.id.localeCompare(b.id),
  name: (a, b) => a.name.localeCompare(b.name),
};
// Best first, models without a score last
for (const [key, field] of [['quality', 'intelligence'], ['coding', 'coding'], ['speed', 'speed']]) {
  SORTS[key] = (a, b) => (score(b, field) ?? -1) - (score(a, field) ?? -1) || a.id.localeCompare(b.id);
}

function showCatalog() {
  if (!catalog) return;
  const words = $('catalogSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const want = { free: $('catalogFree').checked, tools: $('catalogTools').checked, reasoning: $('catalogReasoning').checked, batch: $('catalogBatch').checked, vision: $('catalogVision').checked };
  const maker = $('catalogProvider').value;
  const rated = $('catalogRated').checked;
  catalogShown = catalog.filter(m => (!rated || bench.models?.[m.id]) && (!want.free || m.free) && (!want.tools || m.tools) && (!want.reasoning || m.reasoning) && (!want.batch || m.batch) && (!want.vision || vision(m))
    && (!maker || (m.provider || m.id.split('/')[0]) === maker)
    && words.every(w => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)))
    .sort(SORTS[$('catalogSort').value] || SORTS.new);
  const typed = $('addForm').elements.model.value.trim().replace(/^openrouter\//, '');
  if (!catalogPick && catalog.some(m => m.id === typed)) catalogPick = typed;
  $('catalogRows').innerHTML = catalogShown.slice(0, CATALOG_ROWS).map(m => `<div class="catalog-row${m.id === catalogPick ? ' on' : ''}" role="option" aria-selected="${m.id === catalogPick}" data-id="${esc(m.id)}">
      <span class="cm"><b>${esc(m.name)}${m.batch ? ' <span class="badge">batch</span>' : ''}</b><code>${esc(m.id)}</code></span>
      <span>${pt(score(m, 'intelligence'))}</span>
      <span>${pt(score(m, 'coding'))}</span>
      <span>${pt(score(m, 'speed'))}</span>
      <span>${m.free ? 'free' : `$${perMillion(m.inputCost)}`}</span>
      <span>${m.free ? 'free' : `$${perMillion(m.outputCost)}`}</span></div>`).join('');
  $('catalogNote').textContent = catalogShown.length
    ? `${benchNote()}${catalogShown.length} of ${catalog.length} models${catalogShown.length > CATALOG_ROWS ? `, the first ${CATALOG_ROWS} shown: search or filter to narrow` : ''}. Click one to see its details and fill in the model id.`
    : `None of OpenRouter's ${catalog.length} models match.`;
  showDetail();
}

// One line under the list about where the scores come from, or why there are none
function benchNote() {
  if (!bench.on) return 'No benchmark scores: set ARTIFICIAL_ANALYSIS_API_KEY in .env. ';
  if (bench.error && !bench.count) return `Benchmarks unavailable (${bench.error}). `;
  return '';
}

function benchBlock(m) {
  const b = bench.models?.[m.id];
  if (!bench.on) return `<p class="catalog-bench-note">No benchmark scores yet. Get a free key at <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">artificialanalysis.ai</a>, add <code>ARTIFICIAL_ANALYSIS_API_KEY=…</code> to <code>.env</code>, then restart the Interceptor.</p>`;
  if (!b) return `<p class="catalog-bench-note">${bench.error && !bench.count ? `Benchmarks unavailable: ${esc(bench.error)}` : 'No benchmark data for this model.'}</p>`;
  const bar = (label, v, hint) => (v === null || v === undefined ? '' : `<span class="lbl" data-hint="${esc(hint)}">${label}</span><span class="meter"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><span class="val">${Math.round(v)}</span>`);
  return `<div class="catalog-bench">
      ${bar('Quality', b.intelligence, 'Artificial Analysis intelligence index, 0-100')}
      ${bar('Coding', b.coding, 'Artificial Analysis coding index, 0-100')}
      ${bar('Math', b.math, 'Artificial Analysis math index, 0-100')}
    </div>
    <dl class="facts">
      ${fact('Speed', b.speed ? `${Math.round(b.speed)} tokens/s` : null, 'Median output speed')}
      ${fact('First token', b.ttft ? `${b.ttft} s` : null, 'Median wait for the first token')}
    </dl>
    <p class="catalog-bench-note">Scores for “${esc(b.name)}” from <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a>.</p>`;
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
    ${benchBlock(m)}
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
for (const id of ['catalogFree', 'catalogTools', 'catalogReasoning', 'catalogVision', 'catalogRated', 'catalogBatch', 'catalogProvider', 'catalogSort']) $(id).addEventListener('change', showCatalog);

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
  if (!f.dataset.name) placeAdded(name);
  // Bring a new box into view
  const node = $('world').querySelector(`.node[data-id="${CSS.escape('m:' + name)}"]`);
  node?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  flash([`m:${name}`]);
});

// A new model starts routing at once when the strategy shown has nothing wired;
// otherwise it points to Auto-route and leaves the routes alone.
function placeAdded(name) {
  const r = R();
  const unwired = !r.pin && !r.strong && !r.weak;
  if (unwired && (r !== graph || routerUp())) return wireBasic(r, `Added ${name}.`);
  // A wired strategy is left as it is: the new box has no route yet, and Auto-route can place it
  note(`Added ${name}. It has no route yet: connect it by hand, or press Auto-route to see where it would fit.`, 'ok');
}

// Balanced routing for a strategy with nothing wired, as an unsaved change
function wireBasic(r, lead) {
  const names = servedModels();
  const { stats: numbers, guessed } = AutoRoute.withGuesses(names, stats.models);
  const plan = AutoRoute.preset('balanced', names, numbers, r, graph.fallbacks);
  if (!plan) return false;
  Object.assign(r, plan.routes);
  r.tiers = clone(plan.tiers);
  for (const [m, t] of Object.entries(plan.fallbacks)) ownFb(r)[m] = t;
  tidy();
  changed();
  note(`${lead} Wired ${routingName(r)} with a basic Balanced routing${guessed.length ? ' (quality guessed from price and name)' : ''}: ${plan.routes.strong} for hard requests, ${plan.routes.weak} for easy ones. Press Save to keep it, or change it with Auto-route.`, 'ok');
  return true;
}

// ---- the guide ---------------------------------------------------------------

// Open until the reader closes it once
try { $('guide').open = localStorage.getItem('harness-routing-guide') === 'open'; } catch { $('guide').open = false; }
$('guide').addEventListener('toggle', () => {
  try { localStorage.setItem('harness-routing-guide', $('guide').open ? 'open' : 'closed'); } catch {}
});

// ---- loading and live requests -------------------------------------------

async function load() {
  const [status, settings, gateway, profiles, tools] = await Promise.allSettled([
    getJSON('api/status'), getJSON('api/settings'), getJSON('api/gateway'), getJSON('api/profiles'), getJSON('api/tools'), loadStats()]);
  const router = status.value?.components?.find(c => c.name === 'Router');
  info = {
    router: router?.ok && router.detail?.settings ? router.detail : null,
    routerProblem: router?.problem || (status.reason ? `The Interceptor's status can't be read: ${status.reason.message}` : 'The Router is down or has no admin endpoints.'),
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
    !info.router && `${info.routerProblem} Its choices can’t be changed until then.`,
    profiles.reason && `Named strategies: ${profiles.reason.message}`,
    info.gatewayError && `Models and fallbacks can’t be edited: ${info.gatewayError}`,
  ].filter(Boolean);
  $('updated').textContent = `Loaded ${new Date().toLocaleTimeString()}`;
  $('addModel').disabled = !gatewayEditable();
  // A first visit gets the tidy layout; after that boxes stay where they were put
  const fresh = !Object.keys(positions).length;
  render();
  updateButtons();
  if (fresh) tidy();
  note(issues.join(' '), issues.length ? 'err' : '');
  // A default with nothing wired gets a basic routing, as a draft, so the first
  // visit starts from something that works. One already wired is never touched.
  if (!issues.length && routerUp() && !graph.pin && !graph.strong && !graph.weak) wireBasic(graph, 'The default strategy had no routing.');
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
      // Only requests on the strategy shown light up its lines; any model box still flashes
      const mine = (e.profile || null) === (view ? R().name : null);
      let wires;
      if (!mine) wires = [];
      else if (e.reason?.startsWith('pinned in')) wires = ['fixed', 'entry.pin'];
      else if (e.tier === 'Images') wires = ['fixed', 'entry.images'];
      else if (e.reason) wires = [];
      else if (e.routerError) wires = ['fixed', e.tools ? 'entry.downTools' : 'entry.down'];
      else wires = ['fixed', 'fixed2', ...routeOuts(R()).filter(o => o.node === 'router' && o.model === e.model).map(o => o.port)];
      flash([...wires, `m:${e.model}`]);
    } else if (update.type === 'response' && e.servedBy && e.servedBy !== e.model) {
      flash([['fb', e.model, e.servedBy].join('|'), `m:${e.servedBy}`]);
    }
  };
}

load().catch(err => note(err.message, 'err'));
followLive();
