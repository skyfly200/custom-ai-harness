const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'ui', 'routing.js'), 'utf8');

function loadRemoveModel(graph, profile, other) {
    const from = SOURCE.indexOf('async function removeModel(');
    const end = SOURCE.indexOf('\n}\n\n// Press and hold:', from) + 2;
    assert.ok(from > 0 && end > from, 'ui/routing.js has a removeModel function');
    const fallback = graph.fallbacks;
    const routeOuts = (routing) => Object.entries(routing.routes).map(([port, model]) => ({ port, model, label: port }));
    const ownFb = (routing) => {
        if (routing !== graph && !routing.fallbacks) routing.fallbacks = structuredClone(graph.fallbacks);
        return routing.fallbacks || graph.fallbacks;
    };
    const setOut = (routing, port, model) => { routing.routes[port] = model; };
    const body = `
      let selected = 'wire';
      ${SOURCE.slice(from, end)}
      return { removeModel, selected: () => selected };
    `;
    return new Function('R', 'graph', 'ownFb', 'routeOuts', 'setOut', 'changed', 'note', 'routingName', 'strategies', 'allFb', 'ui', body)(
        () => profile,
        graph,
        ownFb,
        routeOuts,
        setOut,
        () => {},
        (message) => { graph.lastNote = message; },
        () => 'the selected strategy',
        () => [graph, profile, other],
        () => [fallback, profile.fallbacks, other.fallbacks].filter(Boolean),
        { confirm: () => { throw new Error('removing from one strategy should not ask to delete the shared model'); } },
    );
}

test('removing a model from a named strategy leaves the Gateway and other routings alone', async () => {
    const graph = {
        deployments: [{ name: 'model-x' }],
        routes: { strong: 'model-x', weak: 'other' },
        fallbacks: { 'model-x': ['other'], other: ['model-x'] },
    };
    const profile = { name: 'Careful', routes: { strong: 'model-x', weak: 'model-x' }, fallbacks: null };
    const other = { name: 'Quick', routes: { strong: 'model-x', weak: 'other' }, fallbacks: { 'model-x': ['other'] } };
    const { removeModel, selected } = loadRemoveModel(graph, profile, other);

    await removeModel('model-x');

    assert.deepEqual(profile.routes, { strong: null, weak: null });
    assert.deepEqual(profile.fallbacks, {});
    assert.deepEqual(graph.routes, { strong: 'model-x', weak: 'other' });
    assert.deepEqual(graph.deployments, [{ name: 'model-x' }]);
    assert.deepEqual(graph.fallbacks, { 'model-x': ['other'], other: ['model-x'] });
    assert.deepEqual(other.routes, { strong: 'model-x', weak: 'other' });
    assert.deepEqual(other.fallbacks, { 'model-x': ['other'] });
    assert.equal(selected(), null);
    assert.match(graph.lastNote, /Gateway model and other strategies are unchanged/);
});
