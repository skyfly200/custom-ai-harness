// Looks at an existing app's folder and says what stack it is, which host and database it seems to use, and the
// commands and folders an agent would need. Read only: nothing here writes, runs or installs anything. The result
// prefills the Import existing app form; the person can change every choice before the app is registered.
'use strict';

const fs = require('fs');
const path = require('path');

// The files and folders the detection looks at. Anything else in the repo is ignored.
const FILES = [
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Dockerfile', 'fly.toml', 'vercel.json', 'netlify.toml',
    'requirements.txt', 'pyproject.toml', '.env.example', 'prisma/schema.prisma', 'DEPLOY.md', 'index.html',
    '.github/workflows/ci.yml', '.github/workflows/deploy.yml',
];
const DIRS = ['.vercel', 'supabase', '.github/workflows', 'src', 'app', 'pages', 'components', 'lib', 'public', 'styles', 'test', 'tests', 'ui'];
const SOURCE_DIRS = ['src', 'app', 'pages', 'components', 'lib', 'public', 'styles', 'ui', 'test', 'tests'];
const FRAMEWORKS = [['next', 'Next.js'], ['vite', 'Vite'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono']];

const NPM_TEST_PLACEHOLDER = /no test specified/;

/** Dependency names from a package.json text, or [] when it does not parse. */
function depNames(pkg) {
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
}

/**
 * The stack from what is in the folder. `entries` maps a repo-relative path to its text for files (or '' when the
 * text is not needed) and a folder to `null`, with forward slashes. Returns the same shape the form reads.
 */
function detectStack(entries) {
    const has = (p) => Object.prototype.hasOwnProperty.call(entries, p);
    const text = (p) => (has(p) && typeof entries[p] === 'string' ? entries[p] : '');
    const notes = [];
    const stack = [];

    // Node.js: the package.json scripts give the install, test and dev commands
    let pkg = null;
    if (has('package.json')) {
        try { pkg = JSON.parse(text('package.json') || '{}'); } catch { notes.push('package.json does not parse, so its scripts were not read'); pkg = {}; }
        stack.push('Node.js');
        const deps = depNames(pkg);
        for (const [dep, label] of FRAMEWORKS) if (deps.includes(dep)) stack.push(label);
    } else if (has('requirements.txt') || has('pyproject.toml')) {
        stack.push('Python');
    } else if (has('index.html')) {
        stack.push('Static site');
    }
    if (has('Dockerfile')) stack.push('Docker');

    const scripts = pkg?.scripts || {};
    let installCommand = null;
    if (pkg) {
        if (has('pnpm-lock.yaml')) installCommand = 'pnpm install';
        else if (has('yarn.lock')) installCommand = 'yarn install';
        else installCommand = has('package-lock.json') ? 'npm ci' : 'npm install';
    } else if (has('requirements.txt')) {
        installCommand = 'pip install -r requirements.txt';
    }
    const testCommand = scripts.test && !NPM_TEST_PLACEHOLDER.test(scripts.test) ? 'npm test' : null;
    if (pkg && !testCommand) notes.push('No test script in package.json, so the CI workflow will not run tests until you add one');
    const devCommand = scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : null;

    // Where it runs: the first host config found wins; a second one is noted
    const hosts = [];
    if (has('fly.toml')) hosts.push(['flyio', 'fly.toml']);
    if (has('vercel.json') || has('.vercel')) hosts.push(['vercel', 'vercel.json']);
    if (has('netlify.toml')) hosts.push(['netlify', 'netlify.toml']);
    if (has('Dockerfile')) hosts.push(['flyio', 'Dockerfile']);
    const deployTarget = hosts[0]?.[0] || 'none';
    if (hosts[0]) notes.push(`Found ${hosts[0][1]}, so ${{ flyio: 'Fly.io', vercel: 'Vercel', netlify: 'Netlify' }[deployTarget]} is suggested`);
    const distinct = [...new Set(hosts.map((h) => h[0]))];
    if (distinct.length > 1) notes.push(`Several host configs found (${distinct.join(', ')}); the first one is suggested`);
    let previewPort = null;
    const internal = text('fly.toml').match(/internal_port\s*=\s*(\d+)/);
    if (internal && Number(internal[1]) >= 1024 && Number(internal[1]) <= 65535) previewPort = Number(internal[1]);

    // Database hints: Supabase first, then any Postgres (Neon is the suggested Postgres host)
    const deps = pkg ? depNames(pkg) : [];
    const envText = text('.env.example');
    const schema = text('prisma/schema.prisma');
    let database = 'none';
    if (deps.some((d) => d.startsWith('@supabase/')) || has('supabase') || /SUPABASE_/.test(envText)) database = 'supabase';
    else if (deps.some((d) => d === 'pg' || d === 'postgres' || d.startsWith('@neondatabase/') || d === '@prisma/client' || d === 'drizzle-orm') || /neon\.tech|postgres(ql)?:\/\//.test(envText) || /provider\s*=\s*"postgresql"/.test(schema)) database = 'neon';
    if (database !== 'none') notes.push(`Database hints point to ${database === 'supabase' ? 'Supabase' : 'Postgres (Neon)'}`);

    // Folders an agent may edit by default: the source folders that exist, or src/** when none do
    const dirs = SOURCE_DIRS.filter((d) => has(`${d}/`));
    const editablePaths = dirs.length ? dirs.map((d) => `${d}/**`) : ['src/**'];

    const hasCi = has('.github/workflows/ci.yml') || has('.github/workflows/');
    return {
        stack: [...new Set(stack)],
        deployTarget,
        database,
        installCommand,
        testCommand,
        devCommand,
        previewPort,
        editablePaths,
        hasCi,
        hasDeploy: has('.github/workflows/deploy.yml'),
        hasDeployDoc: has('DEPLOY.md'),
        suggestedName: typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : '',
        notes,
    };
}

/** Read the files and folders the detection needs from a folder on disk, as the entries detectStack takes. */
function readEntries(root) {
    const entries = {};
    for (const f of FILES) {
        const full = path.join(root, f);
        try {
            if (fs.statSync(full).isFile()) entries[f] = fs.readFileSync(full, 'utf8');
        } catch { /* not there */ }
    }
    for (const d of DIRS) {
        try { if (fs.statSync(path.join(root, d)).isDirectory()) entries[`${d}/`] = null; } catch { /* not there */ }
    }
    return entries;
}

/** The detection for a folder on disk, plus the repo's GitHub origin when it has one. */
function detectFolder(root) {
    const found = detectStack(readEntries(root));
    return { ...found, githubRepo: githubOrigin(root) };
}

/** owner/name when the folder's `origin` remote is a GitHub repo, else null. */
function githubOrigin(root) {
    try {
        const { execFileSync } = require('child_process');
        const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
        return m ? `${m[1]}/${m[2]}` : null;
    } catch { return null; }
}

module.exports = { detectStack, detectFolder, readEntries, FILES, DIRS };
