#!/bin/bash
# SessionStart hook: install npm dependencies in Claude Code cloud sessions,
# where each session starts from a fresh clone with no node_modules.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
