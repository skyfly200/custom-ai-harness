// What the Dashboard shows about agents: who is busy, what needs a decision,
// what finished lately and what it used. Pure, so it runs in the page
// (window.AgentBoard) and in Node tests (require).
(function (root) {
  const ACTIVE = new Set(['queued', 'running', 'waiting']);
  const tokensOf = (r) => (r.tokens?.in || 0) + (r.tokens?.out || 0);

  // A swarm's own record holds its planner and reviewer; its workers are runs of
  // their own. Spend of a job = the run plus its workers.
  function rollups(runs) {
    const kids = new Map();
    for (const r of runs) if (r.parent) kids.set(r.parent, [...(kids.get(r.parent) || []), r]);
    const out = new Map();
    for (const r of runs) {
      const all = [r, ...(kids.get(r.id) || [])];
      out.set(r.id, {
        tokens: all.reduce((n, x) => n + tokensOf(x), 0),
        cost: all.reduce((n, x) => n + (x.cost || 0), 0),
        unpriced: all.reduce((n, x) => n + (x.unpricedCalls || 0), 0),
      });
    }
    return out;
  }

  // The state a card shows: needs you > working > queued > idle
  function stateOf(agent) {
    if (agent.waiting) return 'waiting';
    const last = agent.lastTask;
    if (agent.active && last?.status === 'queued') return 'queued';
    if (agent.active) return 'working';
    return 'idle';
  }

  function board(runs = [], agents = [], { recent = 6 } = {}) {
    // A swarm's workers are parts of one job: the swarm row stands for them
    const top = runs.filter((r) => !r.parent);
    const spend = rollups(runs);
    const byAgent = new Map();
    for (const r of runs) {
      if (!r.agent || r.parent) continue;
      const t = byAgent.get(r.agent) || { tokens: 0, cost: 0, unpriced: 0, done: 0, failed: 0 };
      const sp = spend.get(r.id);
      t.tokens += sp.tokens; t.cost += sp.cost; t.unpriced += sp.unpriced;
      if (r.status === 'done') t.done++;
      if (r.status === 'failed') t.failed++;
      byAgent.set(r.agent, t);
    }
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const withName = (r) => ({ ...r, spent: spend.get(r.id), agentName: r.agent ? names.get(r.agent) || null : null });
    return {
      // every run asking for a decision, workers included (they are the ones that ask)
      needs: runs.filter((r) => r.status === 'waiting' && r.pending).map(withName),
      agents: agents.map((a) => ({ ...a, state: stateOf(a), ...(byAgent.get(a.id) || { tokens: 0, cost: 0, unpriced: 0, done: 0, failed: 0 }) })),
      active: top.filter((r) => ACTIVE.has(r.status)).map(withName),
      recent: top.filter((r) => !ACTIVE.has(r.status)).slice(0, recent).map(withName),
      totals: {
        active: top.filter((r) => ACTIVE.has(r.status)).length,
        tokens: runs.reduce((n, r) => n + tokensOf(r), 0),
        cost: runs.reduce((n, r) => n + (r.cost || 0), 0),
        unpriced: runs.reduce((n, r) => n + (r.unpricedCalls || 0), 0),
        done: top.filter((r) => r.status === 'done').length,
        failed: top.filter((r) => r.status === 'failed').length,
      },
    };
  }

  const api = { board, stateOf, tokensOf, rollups };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
