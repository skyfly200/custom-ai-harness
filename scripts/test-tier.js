// `npm run test:fast` runs every Node test except the slow ones; `npm run test:slow` runs only those.
// `npm test` still runs everything. Re-measure and edit SLOW when a file crosses about 3 s alone.
require('./check-deps');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SLOW = ['mcp.test.js', 'gateway.test.js', 'spritesSandbox.test.js'];

const root = path.join(__dirname, '..');
const all = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
const picked = process.argv[2] === '--slow' ? all.filter((f) => SLOW.includes(f)) : all.filter((f) => !SLOW.includes(f));
console.log(`Running ${picked.length} of ${all.length} test files`);
process.exit(spawnSync(process.execPath, ['--test', ...picked.map((f) => path.join('test', f))], { cwd: root, stdio: 'inherit' }).status || 0);
