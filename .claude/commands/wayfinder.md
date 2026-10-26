---
description: Map a project goal into destinations, open domain questions, and a dependency-ordered ticket draft
model: claude-sonnet-4-6
---

Plan the following goal across this repository: $ARGUMENTS

Explore the relevant code, documentation, tests, and existing conventions before drafting the plan. Do not edit files, run mutating commands, or create GitHub issues. Treat this as planning only; a person must review the draft before it is turned into tracker issues or marked Ready.

Return one valid JSON object, with no prose or Markdown fences, using this shape:

{
  "goal": "string",
  "destinations": [
    {
      "id": "short-kebab-case-id",
      "outcome": "observable project outcome",
      "domains": ["relevant project area"]
    }
  ],
  "fog_of_war": [
    {
      "id": "short-kebab-case-id",
      "question": "unanswered domain or product question",
      "impact": "what decision or work it affects",
      "blocks": ["ticket-id"]
    }
  ],
  "tickets": [
    {
      "id": "short-kebab-case-id",
      "kind": "build",
      "title": "concise issue title",
      "description": "self-contained issue description",
      "acceptance_criteria": ["verifiable condition"],
      "depends_on": ["ticket-id"],
      "blocked_by_unknowns": ["fog-of-war-id"],
      "parent_id": null,
      "ready": false
    }
  ]
}

Planning rules:
- Map the goal to concrete destinations and use the repository's existing terminology.
- Record consequential unknowns in `fog_of_war`; do not silently make product or architectural decisions. Use decision tickets for questions that need a human decision and research tickets for questions that can be answered from evidence.
- Break implementation into small, independently verifiable build tickets. Use a `build_parent` only when multiple build tickets form one batch.
- Set `kind` to exactly one of `build`, `research`, `decision`, or `build_parent`.
- Make `depends_on` express actual prerequisites, not merely suggested order. Every dependency must reference an existing ticket, and the graph must be acyclic. List tickets in topological order (prerequisites first).
- Use stable, unique IDs throughout the JSON. `blocks` and `blocked_by_unknowns` must reference existing IDs in their respective lists.
- Keep every ticket `ready: false`; Ready is a human-applied tracker mark. Do not claim a draft has been created in GitHub.
- If the goal is too vague to plan safely, return the useful destinations and fog-of-war questions, and leave `tickets` empty rather than inventing requirements.
