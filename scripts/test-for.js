// Runs only the Node tests that mention a changed file: `npm run test:for` (changes vs origin/master
// plus uncommitted ones), or `npm run test:for -- utils/guard.js ui/chat.js` for named files.
// A test counts when its source contains the file's path or its name without the extension.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const git = (...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); } catch { return ''; } };

let files = process.argv.slice(2);
if (!files.length) {
    const base = git('merge-base', 'HEAD', 'origin/master').trim() || 'HEAD';
    files = [...new Set([...git('diff', '--name-only', base).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')])].filter(Boolean);
}

const tests = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
const sources = Object.fromEntries(tests.map((t) => [t, fs.readFileSync(path.join(root, 'test', t), 'utf8')]));
const picked = new Set();
for (const file of files) {
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    for (const t of tests) {
        if (file === `test/${t}` || t === `${name}.test.js` || sources[t].includes(file) || sources[t].includes(`/${name}'`) || sources[t].includes(`/${name}.`)) picked.add(t);
    }
}
if (!picked.size) { console.log('No Node tests mention the changed files. Run `npm test` if unsure.'); process.exit(0); }
console.log(`Running ${picked.size} test file(s): ${[...picked].join(', ')}`);
process.exit(spawnSync(process.execPath, ['--test', ...[...picked].map((t) => path.join('test', t))], { cwd: root, stdio: 'inherit' }).status || 0);
