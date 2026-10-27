// The chat page's commands: a / lists them and one sends its message to that
// command's model for one turn. The page's script is one file for the browser,
// so the command helpers are read out of it and run here.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'chat.js'), 'utf8');
const between = (from, to) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  assert.ok(a > 0 && b > a, `could not find ${from}`);
  return source.slice(a, b);
};

// a fresh context: the helpers need only the commands, the strategies and console
function context({ commands = [], profiles = [] } = {}) {
  const ctx = { commands, strategies: { profiles }, console, JSON };
  vm.createContext(ctx);
  const run = (code, names) => {
    vm.runInContext(`${code}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, ctx);
    return ctx;
  };
  run(between('function slashQuery(', '// A command typed in full'), ['slashQuery']);
  run(between('function expandCommand(', '// A command\'s model box'), ['expandCommand']);
  run(`
    function slashCommand(text) {
      const m = /^\\/([\\w-]+)(?:\\s+([\\s\\S]*))?$/.exec(text);
      if (!m) return null;
      const command = commands.find(c => c.name.toLowerCase() === m[1].toLowerCase());
      return command ? { command, args: (m[2] || '').trim() } : null;
    }`, ['slashCommand']);
  run(`
    function commandModel(command) {
      const w = (command.model || '').trim();
      if (!w) return {};
      const strategy = strategies.profiles.find(x => x.id === w || x.name.toLowerCase() === w.toLowerCase());
      return strategy ? { profile: strategy.id, model: strategy.name } : { model: w };
    }`, ['commandModel']);
  return ctx;
}

const advisor = { name: 'advisor', body: 'Second opinion on: {args}' };
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from another context

test('/ is a command query, and so is a half-typed name', () => {
  const { slashQuery } = context();
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/adv'), 'adv');
  assert.equal(slashQuery('/advisor what now'), 'advisor what now');
  assert.equal(slashQuery('hello /'), null);
  assert.equal(slashQuery('a\nb'), null, 'only the first line is a command');
});

test('a command typed in full gives its name and what follows it', () => {
  const { slashCommand } = context({ commands: [advisor] });
  assert.equal(slashCommand('/advisor is this right?').args, 'is this right?');
  assert.equal(slashCommand('/advisor is this right?').command.name, 'advisor');
  assert.equal(slashCommand('/ADVISOR').command.name, 'advisor', 'names ignore case');
  assert.equal(slashCommand('/advisor').args, '');
  assert.equal(slashCommand('/nope hi'), null, 'an unknown name is a plain message');
  assert.equal(slashCommand('advisor hi'), null, 'no slash, no command');
});

test('{args} fills the message in; without it the args follow the message', () => {
  const { expandCommand } = context();
  assert.equal(expandCommand(advisor, 'this diff'), 'Second opinion on: this diff');
  assert.equal(expandCommand(advisor, ''), 'Second opinion on: (what the person is doing now)');
  assert.equal(expandCommand({ body: 'Summarise.' }, 'the notes'), 'Summarise.\n\nthe notes');
  assert.equal(expandCommand({ body: 'Summarise.' }, ''), 'Summarise.');
});

test("a command's model box takes a model name or a strategy's name", () => {
  const { commandModel } = context({ profiles: [{ id: 'p:careful', name: 'Careful' }] });
  assert.deepEqual(plain(commandModel({ model: 'anthropic/claude-sonnet-4' })), { model: 'anthropic/claude-sonnet-4' });
  assert.deepEqual(plain(commandModel({ model: 'Careful' })), { profile: 'p:careful', model: 'Careful' });
  assert.deepEqual(plain(commandModel({ model: 'p:careful' })), { profile: 'p:careful', model: 'Careful' });
  assert.deepEqual(plain(commandModel({})), {});
  assert.deepEqual(plain(commandModel({ model: '  ' })), {});
});
