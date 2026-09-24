---
status: accepted
---

# The Orchestrator is an optional add-on to a standalone Model Layer

The Model Layer (Interceptor → Router → Gateway) is the core product and must install, run, and be useful with no Orchestrator present: any agent pointed at port 3000 gets routing, compression, fallbacks, and concurrency limits. The Orchestrator is a separate, higher-level add-on that consumes the Model Layer like any other client. We chose this so the core stays small, stateless, and usable on its own, and so the Orchestrator can be built, replaced, or dropped without touching it.

## Considered Options

- **One integrated system** where the Interceptor hosts planning, dispatch, and audit. Rejected: it would drag GitHub state, sessions, and worktrees into a hop that is stateless today, and nobody could use the routing without the orchestration.

## Consequences

- Nothing in the Model Layer may depend on the Orchestrator, read its state, or change behaviour because of it. The dependency only points one way.
- Roadmap items that need memory across requests or sessions belong to the Orchestrator, not the Model Layer. Cross-session context handoff and Pre-triage move there; the Model Layer's context anchor stays within a single request.
- The Model Layer finishes its roadmap phases before Orchestrator work starts.
