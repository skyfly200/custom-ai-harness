# Working in this repo

## Tests

- While developing, run `npm run test:for`. It runs only the Node tests that mention the files you changed (vs origin/master), or name files: `npm run test:for -- utils/guard.js`.
- A single file: `node --test test/<name>.test.js`.
- Run the full `npm test` (about 430 tests, under 30 s) once before opening or pushing a PR. Router tests: `python -m pytest test/` (see docs/development.md).
- Run test files one at a time or through these scripts; don't loop the whole suite repeatedly.
