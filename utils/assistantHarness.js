// The harness's own tools for the assistant: read and change the routing strategies, the agents and the apps.
// They plug into the assistant's tool loop beside the MCP tools (utils/assistantTools.js), so they use the same
// approval path. Reads run at once. Every change waits for the person's /yes, like an MCP server set to ask first.
//
// Routing is changed in this process (utils/profiles.js). Agents and apps are the task runner's API (runner/server.js),
// called the way the Interceptor proxies it, with the runner token and the owner in headers.
// Skills are kept on the server (utils/skillStore.js) and saved there by `save_skill`, after approval.
'use strict';

const DEFAULT_RUNNER = 'http://127.0.0.1:3100';
const WRITE_TOOLS = new Set(['save_routing_strategy', 'create_agent', 'update_agent', 'create_app', 'update_app', 'save_skill']);

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: true });
const str = (description) => ({ type: 'string', description });

const DEFINITIONS = [
    { name: 'list_routing_strategies', description: 'List the routing strategies (named routings): id, name, description and threshold.', parameters: obj({}) },
    {
        name: 'save_routing_strategy',
        description: 'Create a routing strategy, or change one with the same id. Needs the person\'s approval. Use list_routing_strategies first to see what exists.',
        parameters: obj({
            name: str('Name shown on the Routing page'),
            id: str('Id to change an existing strategy; leave out to create one from the name'),
            description: str('When Auto should pick this strategy'),
            note: str('A short note for the person'),
            threshold: { type: 'number', description: 'Win-rate threshold from 0 to 1, or leave out for the default' },
        }, ['name']),
    },
    { name: 'list_agents', description: 'List the agents: id, name, repo, instructions and profile.', parameters: obj({}) },
    {
        name: 'create_agent',
        description: 'Create an agent that runs tasks on a GitHub repo. Needs the person\'s approval.',
        parameters: obj({
            name: str('Agent name'),
            repo: str('The repo the agent works in, owner/name'),
            instructions: str('What the agent is for and how it should work'),
            profile: str('Routing strategy id to use, or leave out'),
        }, ['name', 'repo']),
    },
    {
        name: 'update_agent',
        description: 'Change an agent by id. Needs the person\'s approval.',
        parameters: obj({ id: str('Agent id'), name: str('New name'), instructions: str('New instructions'), profile: str('Routing strategy id') }, ['id']),
    },
    { name: 'list_apps', description: 'List the apps: id, name, repo, editablePaths and test command.', parameters: obj({}) },
    {
        name: 'create_app',
        description: 'Register an app that the person can ask to change. editablePaths says which files an agent may touch, for example ui/**. Needs the person\'s approval.',
        parameters: obj({
            name: str('App name'),
            repo: str('Local repo path, when the app is on this machine'),
            githubRepo: str('owner/name on GitHub, when the app is there'),
            editablePaths: { type: 'array', items: { type: 'string' }, description: 'Globs the agent may edit, for example ["ui/**"]' },
            testCommand: str('Command that runs the tests'),
            devCommand: str('Command that starts the dev server'),
        }, ['name', 'editablePaths']),
    },
    {
        name: 'update_app',
        description: 'Change an app by id. Needs the person\'s approval.',
        parameters: obj({ id: str('App id'), name: str('New name'), editablePaths: { type: 'array', items: { type: 'string' } }, testCommand: str('Test command'), devCommand: str('Dev server command') }, ['id']),
    },
    { name: 'list_skills', description: 'List the skills kept on the server: id, name, description and whether they are off.', parameters: obj({}) },
    {
        name: 'save_skill',
        description: 'Save a skill on the server: a name, a one-line description (when to use it) and the instructions. Give an id, or an existing name, to change that skill. Needs the person\'s approval.',
        parameters: obj({ name: str('kebab-case name, for example review-pr'), description: str('One line: when to use it'), instructions: str('The skill body, in Markdown'), id: str('Id of a skill to change') }, ['name', 'instructions']),
    },
];

const toDefinition = (d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } });

/**
 * @param {object} opts
 * @param {object} opts.profiles   utils/profiles.js (list, replace, get)
 * @param {function} [opts.runnerUrl] () => the task runner's base URL
 * @param {function} [opts.runnerToken] () => the runner token, or ''
 * @param {function} [opts.fetchImpl] fetch, for tests
 * @param {object} [opts.skills] utils/skillStore.js createSkillStore(...)
 */
function createHarnessTools({ profiles, skills, runnerUrl = () => process.env.RUNNER_URL || DEFAULT_RUNNER, runnerToken = () => process.env.RUNNER_TOKEN || '', fetchImpl = fetch }) {
    const names = new Set(DEFINITIONS.map((d) => d.name));

    async function runner(method, path, owner, body) {
        const headers = { 'content-type': 'application/json', 'x-runner-owner': owner || '' };
        if (runnerToken()) headers['x-runner-token'] = runnerToken();
        let res;
        try {
            res = await fetchImpl(`${String(runnerUrl()).replace(/\/$/, '')}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
        } catch (err) {
            throw new Error(`the task runner is not answering (${err.cause?.code || err.message}). Agents and apps need HARNESS_RUNS=1.`);
        }
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) throw new Error(`the task runner answered ${res.status}: ${typeof data === 'object' && data && data.error ? data.error : text.slice(0, 200)}`);
        return data;
    }

    const strategyView = (p) => ({ id: p.id, name: p.name, description: p.description || '', threshold: p.threshold ?? null });
    const pick = (args, keys) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

    const handlers = {
        list_routing_strategies: async () => profiles.list().map(strategyView),

        save_routing_strategy: async (args) => {
            const id = args.id ? String(args.id).trim().toLowerCase() : null;
            const current = profiles.list();
            const existing = id ? current.find((p) => p.id === id) : null;
            if (id && !existing) throw new Error(`no strategy with id ${id}`);
            const next = { ...(existing || {}), ...pick(args, ['name', 'description', 'note', 'threshold']) };
            const list = existing ? current.map((p) => (p.id === id ? next : p)) : [...current, next];
            const saved = profiles.replace(list);
            const row = saved.profiles.find((p) => p.name === next.name);
            return { saved: row ? strategyView(row) : next.name };
        },

        list_agents: async (_args, owner) => (await runner('GET', '/agents', owner)).agents.map((a) => pick(a, ['id', 'name', 'repo', 'instructions', 'profile'])),
        create_agent: async (args, owner) => runner('POST', '/agents', owner, pick(args, ['name', 'repo', 'instructions', 'profile'])),
        update_agent: async (args, owner) => {
            const { id, ...rest } = args;
            return runner('PATCH', `/agents/${encodeURIComponent(String(id))}`, owner, pick(rest, ['name', 'instructions', 'profile']));
        },

        list_apps: async (_args, owner) => (await runner('GET', '/apps', owner)).apps.map((a) => pick(a, ['id', 'name', 'repo', 'githubRepo', 'editablePaths', 'testCommand'])),
        create_app: async (args, owner) => runner('POST', '/apps', owner, pick(args, ['name', 'repo', 'githubRepo', 'editablePaths', 'testCommand', 'devCommand'])),
        update_app: async (args, owner) => {
            const { id, ...rest } = args;
            return runner('PATCH', `/apps/${encodeURIComponent(String(id))}`, owner, pick(rest, ['name', 'editablePaths', 'testCommand', 'devCommand']));
        },

        list_skills: async () => skills.list().map((k) => pick(k, ['id', 'name', 'description', 'disabled'])),
        save_skill: async (args) => {
            const saved = skills.save({ name: args.name, description: args.description, body: args.instructions, id: args.id });
            return pick(saved, ['id', 'name', 'description', 'updated']);
        },
    };

    return {
        has: (name) => names.has(name),
        definitions: () => DEFINITIONS.map(toDefinition),
        needsApproval: (name) => WRITE_TOOLS.has(name),
        async call(name, args = {}, { confirmed = false, owner = '' } = {}) {
            if (!names.has(name)) throw new Error(`no harness tool named ${name}`);
            if (WRITE_TOOLS.has(name) && !confirmed) throw new Error(`${name} needs the person's approval, but none was given`);
            const value = await handlers[name](args, owner);
            return { text: JSON.stringify(value), server: 'harness', tool: name };
        },
    };
}

/** One tool manager over the MCP tools and the harness tools, for the assistant's loop. */
function combine(mcp, harness) {
    const pick = (name) => (harness.has(name) ? harness : mcp);
    return {
        start: async () => { if (mcp && mcp.start) await mcp.start(); },
        definitions: () => [...harness.definitions(), ...(mcp ? mcp.definitions() : [])],
        needsApproval: (name) => (harness.has(name) ? harness.needsApproval(name) : !!mcp && mcp.needsApproval(name)),
        call: (name, args, opts) => pick(name).call(name, args, opts),
    };
}

module.exports = { createHarnessTools, combine, DEFINITIONS, WRITE_TOOLS };
