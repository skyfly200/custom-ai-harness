# Custom AI Harness

A system that plans and executes coding work across frontier, free-tier, and local models while minimising paid-token spend.

## Language

**Model Layer**:
The stateless request-routing stack (Interceptor → Router → Gateway) that any agent can point at as an OpenAI-compatible endpoint.
_Avoid_: proxy (ambiguous; names the whole stack or one hop)

**Interceptor**:
The first hop of the Model Layer; rewrites each request (prompt injection, payload compression, routing hint) before forwarding it.
_Avoid_: server, servers.js

**Router**:
The hop of the Model Layer that classifies a request as strong or weak and picks a model tier.

**Gateway**:
The hop of the Model Layer that holds the model list and fallback chain and makes the actual provider call.

**Orchestrator**:
The stateful layer above the Model Layer that owns planning state, starts agent sessions, dispatches work, and runs audits.
_Avoid_: harness (names the whole system), engine

**Worker**:
A model session the Orchestrator hands one Build Ticket to; it works in its own isolated branch and delivers a pull request.
_Avoid_: agent (too broad), instance

**Build Ticket**:
A unit of implementation work cleared for a Worker, as distinct from a decision ticket on a planning map.
_Avoid_: task, job

**Build Parent**:
An issue that groups one batch of Build Tickets as its sub-issues and orders them with blocking links.
_Avoid_: epic, build map

**Ready**:
The human-applied mark that makes a ticket takeable by the Orchestrator; an open, unblocked ticket without it is never picked up.
_Avoid_: queued, approved (Approved is a post-Audit state)

**Audit**:
A frontier-model review of a Worker's pull request against its Build Ticket, ending in approval or a structured critique.
_Avoid_: review (overloaded with human PR review)

**Escalation**:
Moving a Build Ticket to a stronger tier: Worker → stronger Worker → human, after repeated Audit rejections.

**Pre-triage**:
An Orchestrator step where a cheap model attempts a concrete failure (broken build, failing test, error log) before it escalates.
_Avoid_: Tier 0 (a tier is a Model Layer concept; Pre-triage is a step)

## Relationships

- The **Orchestrator** consumes the **Model Layer**; the **Model Layer** never knows the **Orchestrator** exists.
- The **Model Layer** is the core and runs on its own; the **Orchestrator** is an optional add-on (ADR 0002).
- The **Model Layer** is a chain: **Interceptor** → **Router** → **Gateway** → provider.
- The **Orchestrator** dispatches each **Build Ticket** to one **Worker** and runs an **Audit** on the pull request it delivers.
- After 2 rejected **Audits** a **Build Ticket** gets one **Escalation** to a stronger **Worker**, then goes to the human.
- The **Orchestrator** only works on AFK tickets; HITL decisions happen in the human's own sessions.
- The **Orchestrator** takes only **Ready** tickets: **Build Tickets** and research tickets. It never closes research tickets or edits a planning map; a human session does both.
- A ticket assigned to the human always means it is the human's turn to act.

## Flagged ambiguities

- "Harness" was used for both the proxy stack and the whole system. Resolved: the whole system is the harness; the proxy stack is the **Model Layer**.
