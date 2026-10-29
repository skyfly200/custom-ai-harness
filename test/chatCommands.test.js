// The chat page's newer commands and the state they keep: /advisor, /subagent,
// /plan, and the queue of messages typed while a reply is still arriving. Like
// test/commands.test.js, the page's script is one browser file, so the helpers are
// read out of it and run in a Node context with just what they need.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');
const modelAlias = require('../utils/modelAlias');

const between = (from, to) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  assert.ok(a > 0 && b > a, `could not find ${from}`);
  return source.slice(a, b);
};

// Just enough of the page: the model list, a chat, a toast, and the two calls the
// advisor command makes while it saves.
function context({ chat = { id: 'c1', messages: [] }, models = [], commands = [] } = {}) {
  const toasts = [];
  const saved = [];
  const ctx = {
    chat, gatewayModels: models, commands, modelAlias, console, JSON, Date,
    toast: (t) => toasts.push(t),
    saveChat: (c) => saved.push(c),
    drawAdvisor: () => {}, drawHint: () => {},
    expandCommand: (c, args) => c.body.replace(/\{args\}/g, args || ''),
    esc: (s) => String(s),
    toasts, saved,
  };
  vm.createContext(ctx);
  const run = (code, names) => {
    vm.runInContext(`${code}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);
    return ctx;
  };
  run(between('const advisorOf =', 'function drawAdvisor'), ['advisorOf']);
  run(between('function resolveModelName(', 'function serverTools'), ['resolveModelName']);
  run(between('function advisorCommand(', '// Messages typed while a reply'), ['advisorCommand']);
  return ctx;
}

function subagentContext({ models = SERVED, response = { id: 'r1', branch: 'harness/r1' } } = {}) {
  const toasts = [];
  const saved = [];
  const requests = [];
  const chat = { id: 'c1', messages: [] };
  const ctx = {
    chat, gatewayModels: models, modelAlias, console, JSON, Date,
    repoOf: () => ({ path: 'C:\\repos\\demo', name: 'demo' }),
    routeOf: () => ({ model: 'auto' }),
    toast: (t) => toasts.push(t),
    saveChat: (c) => saved.push(c),
    drawLog: () => {},
    autoGrow: () => {},
    uid: () => 'note-1',
    $: () => ({ value: 'command text' }),
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => response };
    },
    toasts, saved, requests,
  };
  vm.createContext(ctx);
  const run = (code, names) => {
    vm.runInContext(`${code}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);
    return ctx;
  };
  run(between('function resolveModelName(', 'function serverTools'), ['resolveModelName']);
  run(between('function subagentCommand(', '// Messages typed while a reply'), ['subagentCommand']);
  return ctx;
}

const SERVED = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-4.5', 'fast-openrouter'];

test('/advisor is not a plain message: it sets the chat up and says so', async () => {
  const ctx = context({ models: SERVED });
  const handled = ctx.advisorCommand('/advisor opus');
  assert.ok(handled && typeof handled.then === 'function', 'the command claims the message');
  await handled;
  assert.equal(ctx.chat.advisor.model, 'anthropic/claude-opus-5.5');
  assert.equal(ctx.chat.advisor.typed, 'opus', 'what was typed is kept, to show it back');
  assert.equal(ctx.saved.length, 1, 'the chat is saved with it');
  assert.match(ctx.toasts.at(-1), /anthropic\/claude-opus-5\.5/);
});

test('anything else is left to the ordinary message path', () => {
  const ctx = context({ models: SERVED });
  for (const text of ['hello', '/advice', '/subagent opus do a thing', '/plan x']) {
    assert.equal(ctx.advisorCommand(text), null, text);
  }
});

test('a name nothing matches is refused and the near misses are offered', async () => {
  const ctx = context({ models: SERVED });
  await ctx.advisorCommand('/advisor gpt-9');
  assert.equal(ctx.chat.advisor, undefined, 'nothing is set');
  assert.match(ctx.toasts.at(-1), /No model matches/);
});

test('/advisor with no name says how to use it, and off removes it', async () => {
  const ctx = context({ models: SERVED, chat: { id: 'c1', messages: [], advisor: { model: 'anthropic/claude-opus-5.5' } } });
  await ctx.advisorCommand('/advisor');
  assert.match(ctx.toasts.at(-1), /Advisor: anthropic\/claude-opus-5\.5/);
  await ctx.advisorCommand('/advisor off');
  assert.equal(ctx.chat.advisor, undefined);
  assert.match(ctx.toasts.at(-1), /removed/);
});

test('a full model name is used as typed, short ones find the newest', () => {
  const ctx = context({ models: SERVED });
  assert.equal(ctx.resolveModelName('opus').model, 'anthropic/claude-opus-5.5');
  assert.equal(ctx.resolveModelName('fast-openrouter').model, 'fast-openrouter');
  assert.equal(ctx.resolveModelName('nope').model, null);
});

test('/subagent starts a separate run with the selected model and the chat route', async () => {
  const ctx = subagentContext();
  await ctx.subagentCommand('/subagent haiku find the config loader');
  assert.equal(ctx.requests[0].url, 'api/runs');
  assert.equal(ctx.requests[0].body.goal, 'find the config loader');
  assert.equal(ctx.requests[0].body.repo, 'C:\\repos\\demo');
  assert.equal(ctx.requests[0].body.model, 'anthropic/claude-haiku-4.5');
  assert.equal(ctx.requests[0].body.plan, '0');
  assert.match(ctx.toasts.at(-1), /Subagent started: r1/);
  assert.match(ctx.chat.messages[0].content, /Agents page/);
});

test('/plan starts a no-change run without treating the task as a model name', async () => {
  const ctx = subagentContext();
  await ctx.subagentCommand('/plan inspect the config loader');
  assert.equal(ctx.requests[0].body.goal, 'inspect the config loader');
  assert.equal(ctx.requests[0].body.plan, '1');
  assert.equal(ctx.requests[0].body.model, 'auto');
  assert.match(ctx.toasts.at(-1), /Plan started/);
});

test('the advisor is asked with its model and no tools, and a short answer comes back', () => {
  const advisor = require('../utils/advisor');
  const r = advisor.request({ model: 'anthropic/claude-opus-5.5' }, { question: 'Is this right?', context: 'a = 1' });
  assert.equal(r.model, 'anthropic/claude-opus-5.5');
  assert.equal(r.stream, false);
  assert.equal(r.tools, undefined, 'the advisor has no tools of its own');
  const out = advisor.answer({ choices: [{ message: { content: 'It is.' } }] });
  assert.equal(out.text, 'It is.');
  assert.equal(out.isError, false);
});

// /model: switches what the chat answers with, like the "Answer with" picker
function modelContext({ models = SERVED, profiles = [{ id: 'cheap', name: 'Cheap' }] } = {}) {
  const toasts = [];
  const chat = { id: 'c1', messages: [] };
  const input = { value: '/model opus' };
  const ctx = {
    chat, gatewayModels: models, modelAlias, console, JSON, Date,
    strategies: { profiles },
    toasts, input,
    $: () => input,
    toast: (t) => toasts.push(t),
    saveChat: () => {}, autoGrow: () => {}, hideSlash: () => {}, drawSlash: () => {},
    drawRoute: () => {}, drawTools: () => {}, drawHint: () => {}, drawStats: () => {}, drawEffort: () => {}, redrawQuick: () => {},
    routeOf: () => ({}),
    applyQuick: (c, v) => { if (v.startsWith('m:')) { c.route = 'model'; c.model = v.slice(2); } else c.route = v; },
  };
  vm.createContext(ctx);
  const run = (code, names) => vm.runInContext(`${code}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);
  run(between('function resolveModelName(', 'function serverTools'), ['resolveModelName']);
  run(between('function modelCommand(', '// ---------------------------------------------------------------------------\n// Subagents:'), ['modelCommand']);
  run(between('function modelArgument(', 'const MODEL_MENU_ROWS'), ['modelArgument']);
  return ctx;
}

test('/model opus points the chat straight at the newest Opus', async () => {
  const ctx = modelContext();
  await ctx.modelCommand('/model opus');
  assert.equal(ctx.chat.route, 'model');
  assert.equal(ctx.chat.model, 'anthropic/claude-opus-5.5');
  assert.match(ctx.toasts.at(-1), /now answers with anthropic\/claude-opus-5\.5/);
});

test('/model takes a strategy by name, and default and auto', async () => {
  const ctx = modelContext();
  await ctx.modelCommand('/model cheap');
  assert.equal(ctx.chat.route, 'p:cheap');
  await ctx.modelCommand('/model auto');
  assert.equal(ctx.chat.route, 'auto');
});

test('/model with no name lists the choices instead of changing anything', async () => {
  const ctx = modelContext();
  await ctx.modelCommand('/model');
  assert.equal(ctx.chat.route, undefined);
  assert.equal(ctx.input.value, '/model ');
});

test('/model with a name nothing matches offers near misses and changes nothing', async () => {
  const ctx = modelContext();
  await ctx.modelCommand('/model gpt-9');
  assert.equal(ctx.chat.route, undefined);
  assert.match(ctx.toasts.at(-1), /No model matches "gpt-9"/);
  assert.equal(ctx.modelCommand('/modelx'), null);
  assert.equal(ctx.modelCommand('hello'), null);
});

test('the model suggestion list shows for /advisor, /model and the first word of /subagent', () => {
  const { modelArgument } = modelContext();
  assert.deepEqual({ ...modelArgument('/advisor op') }, { command: 'advisor', query: 'op' });
  assert.deepEqual({ ...modelArgument('/model ') }, { command: 'model', query: '' });
  assert.deepEqual({ ...modelArgument('/subagent ha') }, { command: 'subagent', query: 'ha' });
  assert.equal(modelArgument('/subagent haiku find it'), null, 'past the model, it is the task');
  assert.equal(modelArgument('/advisor off'), null);
  assert.equal(modelArgument('/agent Docs op'), null);
  assert.equal(modelArgument('/advisor'), null);
});
