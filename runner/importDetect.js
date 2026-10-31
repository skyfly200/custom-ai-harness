// Looks at an existing app's folder and says what stack it is, which host and database it seems to use, and the
// commands and folders an agent would need. Read only: nothing here writes, runs or installs anything. The result
// prefills the Import existing app form; the person can change every choice before the app is registered.
//
// Hosts and databases are scored: each file or line that points at one adds points and a short piece of evidence.
// The highest score is suggested, the rest are listed as candidates with their evidence, so the person can see why.
'use strict';

const fs = require('fs');
const path = require('path');

// The files and folders the detection looks at. Anything else in the repo is ignored. Secrets files (.env) are never
// read: only .env.example is.
const FILES = [
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Dockerfile', 'fly.toml', 'vercel.json', 'now.json',
    'netlify.toml', '_redirects', '_headers', 'public/_redirects', 'public/_headers', '.vercel/project.json', '.netlify/state.json',
    'requirements.txt', 'pyproject.toml', '.env.example', 'prisma/schema.prisma', 'DEPLOY.md', 'README.md', 'README', 'index.html',
    '.github/workflows/ci.yml', '.github/workflows/deploy.yml',
];
const DIRS = ['.vercel', '.netlify', 'supabase', '.github/workflows', 'src', 'app', 'pages', 'components', 'lib', 'public', 'styles', 'test', 'tests', 'ui'];
const SOURCE_DIRS = ['src', 'app', 'pages', 'components', 'lib', 'public', 'styles', 'ui', 'test', 'tests'];
const FRAMEWORKS = [['next', 'Next.js'], ['vite', 'Vite'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono']];
const HOST_LABELS = { flyio: 'Fly.io', vercel: 'Vercel', netlify: 'Netlify' };
const DB_LABELS = { supabase: 'Supabase', neon: 'Postgres (Neon)' };
// Vercel's own database packages run on Neon or other hosts, so they say nothing about Vercel as a host.
const VERCEL_DATA_PACKAGES = ['@vercel/postgres', '@vercel/kv', '@vercel/blob', '@vercel/edge-config'];
const WORKFLOW_MAX_BYTES = 256 * 1024;
const WORKFLOW_MAX_FILES = 20;

const NPM_TEST_PLACEHOLDER = /no test specified/;
const FLY_WORKFLOW = /flyctl|superfly\/flyctl-actions|\bfly deploy\b/i;
const VERCEL_WORKFLOW = /\bvercel\b/i;
const NETLIFY_WORKFLOW = /\bnetlify\b/i;

/** Dependency names from a package.json object, or [] when there is none. */
function depNames(pkg) {
    return Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
}

/**
 * Candidates keyed by id, in the order given (the tie-break). `add` records points and the evidence for them; `ranked`
 * returns the ones with any points, highest first.
 */
function tally(order) {
    const map = new Map(order.map((id) => [id, { id, score: 0, evidence: [] }]));
    return {
        add(id, points, why) {
            const c = map.get(id);
            c.score += points;
            c.evidence.push(why);
        },
        ranked() {
            return [...map.values()]
                .filter((c) => c.score > 0)
                .sort((a, b) => b.score - a.score || order.indexOf(a.id) - order.indexOf(b.id));
        },
    };
}

/** The hostnames in `s` (after `//` or `@`, so any URL scheme counts), lower-cased. */
function hostsIn(s) {
    return [...String(s).matchAll(/(?:\/\/|@)([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
}

/**
 * The stack from what is in the folder. `entries` maps a repo-relative path to its text for files (or '' when the
 * text is not needed) and a folder to `null`, with forward slashes. Returns the same shape the form reads, plus
 * `hostCandidates` and `databaseCandidates`: every option with a score and its evidence, best first.
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

    const deps = pkg ? depNames(pkg) : [];
    const workflows = Object.keys(entries).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort();
    const readme = text('README.md') || text('README');
    const homepage = typeof pkg?.homepage === 'string' ? pkg.homepage : '';

    // Where it runs: each host is scored from config files, packages, CI workflows and links in the docs
    const hosts = tally(['flyio', 'vercel', 'netlify']);
    if (has('fly.toml')) hosts.add('flyio', 5, 'fly.toml');
    if (has('Dockerfile')) hosts.add('flyio', 2, 'Dockerfile (Fly builds it)');
    if (has('vercel.json')) hosts.add('vercel', 5, 'vercel.json');
    if (has('now.json')) hosts.add('vercel', 4, 'now.json (older Vercel config)');
    if (has('.vercel/') || has('.vercel/project.json')) hosts.add('vercel', 5, '.vercel/ folder from vercel link');
    if (has('netlify.toml')) hosts.add('netlify', 5, 'netlify.toml');
    if (has('.netlify/') || has('.netlify/state.json')) hosts.add('netlify', 5, '.netlify/ folder from netlify link');
    if (has('_redirects') || has('public/_redirects') || has('_headers') || has('public/_headers')) hosts.add('netlify', 3, '_redirects or _headers (Netlify syntax)');
    const vercelPkgs = deps.filter((d) => (d === 'vercel' || d.startsWith('@vercel/')) && !VERCEL_DATA_PACKAGES.includes(d));
    if (vercelPkgs.length) hosts.add('vercel', 2, `package.json uses ${vercelPkgs.join(', ')}`);
    const netlifyPkgs = deps.filter((d) => d === 'netlify-cli' || d.startsWith('@netlify/'));
    if (netlifyPkgs.length) hosts.add('netlify', 2, `package.json uses ${netlifyPkgs.join(', ')}`);
    if (deps.includes('next')) hosts.add('vercel', 2, 'Next.js (usually deployed on Vercel)');
    for (const h of hostsIn(homepage)) {
        if (h.endsWith('.vercel.app')) hosts.add('vercel', 3, `homepage is ${h}`);
        if (h.endsWith('.netlify.app')) hosts.add('netlify', 3, `homepage is ${h}`);
    }
    for (const h of new Set(hostsIn(readme))) {
        if (h.endsWith('.vercel.app') || h === 'vercel.com') hosts.add('vercel', 2, `README links to ${h}`);
        if (h.endsWith('.netlify.app') || h === 'app.netlify.com') hosts.add('netlify', 2, `README links to ${h}`);
    }
    if (/vercel\.com\/(button|new\/clone)/i.test(readme)) hosts.add('vercel', 3, 'README has a Vercel deploy button');
    if (/app\.netlify\.com\/start\/deploy/i.test(readme)) hosts.add('netlify', 3, 'README has a Netlify deploy button');
    for (const w of workflows) {
        const body = text(w);
        const name = path.basename(w);
        if (FLY_WORKFLOW.test(body)) hosts.add('flyio', 3, `${name} deploys with flyctl`);
        if (VERCEL_WORKFLOW.test(body)) hosts.add('vercel', 3, `${name} uses Vercel`);
        if (NETLIFY_WORKFLOW.test(body)) hosts.add('netlify', 3, `${name} uses Netlify`);
    }
    const hostCandidates = hosts.ranked().map((c) => ({ ...c, label: HOST_LABELS[c.id] }));
    const deployTarget = hostCandidates[0]?.id || 'none';

    // Database hints: each source is scored, Supabase and Neon are the suggested hosts
    const dbs = tally(['supabase', 'neon']);
    const envText = text('.env.example');
    const schema = text('prisma/schema.prisma');
    const envLines = envText.split(/\r?\n/);
    if (deps.some((d) => d.startsWith('@supabase/'))) dbs.add('supabase', 5, `package.json uses ${deps.filter((d) => d.startsWith('@supabase/')).join(', ')}`);
    if (has('supabase/') || has('supabase/config.toml')) dbs.add('supabase', 4, 'supabase/ folder (Supabase CLI project)');
    if (/SUPABASE_/.test(envText)) dbs.add('supabase', 3, '.env.example has SUPABASE_ settings');
    if (deps.some((d) => d.startsWith('@neondatabase/'))) dbs.add('neon', 5, `package.json uses ${deps.filter((d) => d.startsWith('@neondatabase/')).join(', ')}`);
    if (deps.includes('@vercel/postgres')) dbs.add('neon', 4, '@vercel/postgres (Neon under the hood)');
    if (deps.includes('pg') || deps.includes('postgres')) dbs.add('neon', 3, 'a Postgres client package (pg or postgres)');
    if (deps.includes('drizzle-orm')) dbs.add('neon', 2, 'drizzle-orm (often Postgres)');
    if (deps.includes('@prisma/client')) dbs.add('neon', 2, '@prisma/client (often Postgres)');
    if (/provider\s*=\s*"postgresql"/.test(schema)) dbs.add('neon', 3, 'prisma/schema.prisma uses PostgreSQL');
    for (const line of envLines) {
        const hosting = hostsIn(line);
        if (hosting.some((h) => h.endsWith('neon.tech'))) dbs.add('neon', 5, '.env.example points at a neon.tech host');
        else if (hosting.some((h) => h.endsWith('supabase.co') || h.endsWith('supabase.com'))) dbs.add('supabase', 5, '.env.example points at a supabase host');
        else if (/postgres(ql)?:\/\//.test(line)) dbs.add('neon', 2, 'a Postgres URL in .env.example');
    }
    const databaseCandidates = dbs.ranked().map((c) => ({ ...c, label: DB_LABELS[c.id] }));
    const database = databaseCandidates[0]?.id || 'none';

    // Notes: what was suggested and why, and what else looked possible
    if (hostCandidates[0]) notes.push(`${HOST_LABELS[deployTarget]} is suggested: ${hostCandidates[0].evidence.join('; ')}`);
    const strongHosts = hostCandidates.filter((c) => c.score >= 4);
    if (strongHosts.length > 1) notes.push(`Several host configs found (${strongHosts.map((c) => c.label).join(', ')}); the first one is suggested`);
    else if (hostCandidates.length > 1) notes.push(`Also possible: ${hostCandidates.slice(1).map((c) => `${c.label} (${c.evidence.join(', ')})`).join('; ')}`);
    if (databaseCandidates[0]) notes.push(`Database hints point to ${databaseCandidates[0].label}: ${databaseCandidates[0].evidence.join('; ')}`);
    if (databaseCandidates.length > 1) notes.push(`Also possible database: ${databaseCandidates.slice(1).map((c) => `${c.label} (${c.evidence.join(', ')})`).join('; ')}`);

    let previewPort = null;
    const internal = text('fly.toml').match(/internal_port\s*=\s*(\d+)/);
    if (internal && Number(internal[1]) >= 1024 && Number(internal[1]) <= 65535) previewPort = Number(internal[1]);

    // Folders an agent may edit by default: the source folders that exist, or src/** when none do
    const dirs = SOURCE_DIRS.filter((d) => has(`${d}/`));
    const editablePaths = dirs.length ? dirs.map((d) => `${d}/**`) : ['src/**'];

    const hasCi = has('.github/workflows/ci.yml') || workflows.length > 0;
    return {
        stack: [...new Set(stack)],
        deployTarget,
        database,
        hostCandidates,
        databaseCandidates,
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
    // Every workflow file: any of them may deploy to a host
    const wfDir = path.join(root, '.github/workflows');
    try {
        const names = fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)).sort().slice(0, WORKFLOW_MAX_FILES);
        for (const n of names) {
            const full = path.join(wfDir, n);
            if (fs.statSync(full).size <= WORKFLOW_MAX_BYTES) entries[`.github/workflows/${n}`] = fs.readFileSync(full, 'utf8');
        }
    } catch { /* no workflows */ }
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
