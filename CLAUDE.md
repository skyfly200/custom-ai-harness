# Working in this repo

For how the parts fit together and where each concern lives, read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Tests

- While developing, run `npm run test:for`. It runs only the Node tests that mention the files you changed (vs origin/master), or name files: `npm run test:for -- utils/guard.js`.
- `npm run test:fast` skips the 3 slowest files (mcp, gateway, spritesSandbox); `npm run test:slow` runs just those.
- Fake Gateways for tests: `fakeGateway()` in `test/helpers/stubs.js`; don't write another `http.createServer` stub. The index of which tests cover what is in docs/development.md.
- A single file: `node --test test/<name>.test.js`.
- Run the full `npm test` (about 430 tests, under 30 s) once before opening or pushing a PR. Router tests: `python -m pytest test/` (see docs/development.md).
- Run test files one at a time or through these scripts; don't loop the whole suite repeatedly.

## Web UI

- Never use native `alert()`, `confirm()` or `prompt()` in `ui/`; use `ui.toast`, `ui.confirm`, `ui.prompt` from `ui/dialogs.js` (see docs/development.md). `test/dialogs.test.js` enforces it.
