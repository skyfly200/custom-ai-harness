// What the Dashboard shows about agents: who is busy, what needs a decision,
// what finished lately and what it used. Pure, so it runs in the page
// (window.AgentBoard) and in Node tests (require).
(function (root) {
  const ACTIVE = new Set(['queued', 'running', 'waiting']);
  const tokensOf = (r) => (r.tokens?.in || 0) + (r.tokens?.out || 0);

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
    const byAgent = new Map();
    for (const r of runs) {
      if (!r.agent) continue;
      const t = byAgent.get(r.agent) || { tokens: 0, done: 0, failed: 0 };
      t.tokens += tokensOf(r);
      if (r.status === 'done') t.done++;
      if (r.status === 'failed') t.failed++;
      byAgent.set(r.agent, t);
    }
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const withName = (r) => ({ ...r, agentName: r.agent ? names.get(r.agent) || null : null });
    return {
      // every run asking for a decision, workers included (they are the ones that ask)
      needs: runs.filter((r) => r.status === 'waiting' && r.pending).map(withName),
      agents: agents.map((a) => ({ ...a, state: stateOf(a), ...(byAgent.get(a.id) || { tokens: 0, done: 0, failed: 0 }) })),
      active: top.filter((r) => ACTIVE.has(r.status)).map(withName),
      recent: top.filter((r) => !ACTIVE.has(r.status)).slice(0, recent).map(withName),
      totals: {
        active: top.filter((r) => ACTIVE.has(r.status)).length,
        tokens: top.reduce((n, r) => n + tokensOf(r), 0) + runs.filter((r) => r.parent).reduce((n, r) => n + tokensOf(r), 0),
        done: top.filter((r) => r.status === 'done').length,
        failed: top.filter((r) => r.status === 'failed').length,
      },
    };
  }

  const api = { board, stateOf, tokensOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
