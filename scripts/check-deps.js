// Fails fast with a clear message when a package.json dependency isn't installed, instead of
// every test that needs it dying with "Cannot find module". Runs before the test scripts.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const missing = names.filter((n) => !fs.existsSync(path.join(root, 'node_modules', n, 'package.json')));
if (missing.length) {
    console.error(`Missing packages: ${missing.join(', ')}\nRun \`npm install\`, then try again.`);
    process.exit(1);
}
