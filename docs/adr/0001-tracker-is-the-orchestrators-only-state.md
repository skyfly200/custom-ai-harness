---
status: accepted
---

# The tracker is the Orchestrator's only state

The Orchestrator keeps no database or local store: everything it needs to resume a run (state, attempt count, PR number, Claude session ID) lives on the GitHub issue, in a hidden JSON block inside the one status comment it owns. Everything else is derived by convention from the issue number: the branch `orchestrator/<issue#>` and the worktree path. We chose this so the Orchestrator can crash, be wiped, or move machines and rebuild itself entirely from GitHub, with one place to look and no second copy to drift out of sync.

## Considered Options

- **Tracker for human-facing state, plus a rebuildable local cache** (e.g. SQLite for worktree paths, session IDs, token counts). Rejected: even a cache that "can always be rebuilt" becomes a second source people and code start trusting.
- **Local store as the source of truth, tracker as a mirror.** Rejected: humans work from the tracker, so the mirror would be what they act on while being the stale copy.

## Consequences

- Every resume and frontier scan is a GitHub API read, so the Orchestrator must stay within the App's API rate limit. This is a constraint on the process-shape and concurrency decisions.
- The status comment's hidden JSON block is a schema. Changing it means handling the old shape on issues that are already in flight.
- Anything not worth putting on an issue (raw logs, full transcripts) is not kept at all unless linked from the issue as an asset.
