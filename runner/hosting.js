// Hosting for a new app: the CI workflow, a deploy workflow for the chosen host, the database settings and a
// DEPLOY.md that lists what the person must connect. The files are plain text written into the app's repo.
// Nothing here holds a credential: the workflows read secrets the person adds to the GitHub repo, and the
// harness never sees those values.
'use strict';

const TARGETS = {
    none: {
        label: 'Not yet',
        help: 'Tests run on GitHub for every change, but nothing goes on the internet yet.',
        secrets: [],
        account: null,
    },
    vercel: {
        label: 'Vercel',
        help: 'Builds and hosts web front ends and server functions, with a free tier. Pick it for sites and Next.js-style apps.',
        secrets: ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'],
        account: 'A Vercel account. Make a token under Account Settings > Tokens, then run `npx vercel link` once in the repo to get the org and project ids.',
    },
    netlify: {
        label: 'Netlify',
        help: 'Hosts static sites and serverless functions, with a free tier. Best for static sites; a plain Node server needs an adapter first.',
        secrets: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'],
        account: 'A Netlify account. Make a personal access token under User settings > Applications, and create a site to get its site id (API id).',
    },
    flyio: {
        label: 'Fly.io',
        help: 'Runs the app as a small server close to you, and it can sleep when idle. Pick it for a server like the web app template.',
        secrets: ['FLY_API_TOKEN'],
        account: 'A Fly.io account. Run `fly tokens create deploy` and keep the whole output, including the `FlyV1 ` prefix.',
    },
};

const DATABASES = {
    none: {
        label: 'No database',
        help: 'The app keeps no data beyond its own files.',
        env: [],
        secrets: [],
        account: null,
    },
    neon: {
        label: 'Neon',
        help: 'Serverless Postgres, a normal SQL database with a free tier that sleeps when idle.',
        env: ['DATABASE_URL'],
        secrets: ['DATABASE_URL'],
        account: 'A Neon account. Create a project and copy its pooled connection string (it starts with postgres://).',
    },
    supabase: {
        label: 'Supabase',
        help: 'Postgres with a dashboard, sign-in and file storage. Pick it when you want those extras.',
        env: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
        secrets: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
        account: 'A Supabase account. Create a project, then copy the project URL and the anon key from its API settings.',
    },
};

/** The choice as an id, or throws when it is not one of the options. */
function targetId(v) {
    const id = String(v || 'none');
    if (!TARGETS[id]) throw new Error(`deploy target must be one of ${Object.keys(TARGETS).join(', ')}`);
    return id;
}

function databaseId(v) {
    const id = String(v || 'none');
    if (!DATABASES[id]) throw new Error(`database must be one of ${Object.keys(DATABASES).join(', ')}`);
    return id;
}

/** What the Apps page shows for each option: label, plain-English help and the accounts or secrets it needs. */
function catalog() {
    const pick = (table) => Object.entries(table).map(([id, o]) => ({ id, label: o.label, help: o.help, account: o.account, secrets: o.secrets }));
    return { targets: pick(TARGETS), databases: pick(DATABASES) };
}

// A command goes into a YAML file, so only plain shell words get through (the template's own commands always do).
const COMMAND = /^[\w .:@/=+-]{1,200}$/;
function command(text, fallback) {
    const v = String(text || fallback || '').trim();
    if (!v) return null;
    if (!COMMAND.test(v)) throw new Error(`command ${v} has characters a workflow cannot run safely`);
    return v;
}

/** The workflow that tests every push and pull request. */
function ciWorkflow({ install, test }) {
    return `name: CI
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: ${install}
      - run: ${test || 'echo "No test command set"'}
`;
}

/** The deploy steps for each host. Each reads its secrets from the GitHub repo, never from this file. */
function deploySteps(target, build) {
    if (target === 'vercel') return [
        '      - run: npm install --global vercel@latest',
        '      - run: vercel pull --yes --environment=production --token="$VERCEL_TOKEN"',
        '      - run: vercel build --prod --token="$VERCEL_TOKEN"',
        '      - run: vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"',
    ];
    if (target === 'netlify') return [
        `      - run: ${build || 'echo "No build step"'}`,
        '      - run: npx --yes netlify-cli deploy --prod --dir=public --site="$NETLIFY_SITE_ID" --auth="$NETLIFY_AUTH_TOKEN"',
    ];
    if (target === 'flyio') return [
        '      - uses: superfly/flyctl-actions/setup-flyctl@master',
        '      - run: flyctl deploy --remote-only',
    ];
    return [];
}

/** The deploy workflow: on each push to the default branch, test again, then deploy with the chosen host. */
function deployWorkflow({ target, install, test, build, env }) {
    const info = TARGETS[target];
    const steps = deploySteps(target, build);
    const secrets = [...info.secrets, ...env];
    const envBlock = secrets.length ? `    env:\n${secrets.map((s) => `      ${s}: \${{ secrets.${s} }}`).join('\n')}\n` : '';
    return `name: Deploy to ${info.label}
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
${envBlock}    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: ${install}
      - run: ${test || 'echo "No test command set"'}
${steps.join('\n')}
`;
}

/** DEPLOY.md: the plain-English checklist of what to connect, in order. */
function connectDoc({ name, target, database }) {
    const t = TARGETS[target];
    const d = DATABASES[database];
    const lines = [`# Connect ${name}`, '', 'The harness wrote the CI and deploy files in this repo. It did not create any account or key for you. These are the steps to finish the setup.', ''];
    lines.push(`## What this app uses`, '', `- Hosting: ${t.label}. ${t.help}`, `- Database: ${d.label}. ${d.help}`, '');
    lines.push('## Steps', '');
    let n = 1;
    if (t.account) lines.push(`${n++}. ${t.label}: ${t.account}`);
    if (d.account) lines.push(`${n++}. ${d.label}: ${d.account}`);
    lines.push(`${n++}. In this repo on GitHub, open Settings > Secrets and variables > Actions, and add each secret below.`);
    lines.push(`${n++}. Push to \`main\`. CI tests every push; the deploy workflow runs after the tests pass.`);
    lines.push('');
    const secrets = [...t.secrets, ...d.secrets];
    if (secrets.length) {
        lines.push('## GitHub secrets to add', '', '| Secret | Used by |', '| --- | --- |');
        for (const s of t.secrets) lines.push(`| \`${s}\` | ${t.label} deploy |`);
        for (const s of d.secrets) lines.push(`| \`${s}\` | ${d.label} (the app's database connection) |`);
        lines.push('');
    }
    if (d.env.length) {
        lines.push('## Local development', '', 'Copy `.env.example` to `.env` and fill in the values. `.env` is git-ignored and never committed.', '');
    }
    if (target !== 'none' && d.env.length) {
        lines.push(`The deploy workflow passes the database values to the build. ${t.label} also needs them in its own settings (for Fly.io, \`fly secrets set\`), with the same names and values.`, '');
    }
    return lines.join('\n');
}

/**
 * The files for the chosen hosting, as { path, text }. Always the CI workflow; a deploy workflow when the app
 * has a host; .env.example when it has a database; DEPLOY.md when there is anything to connect.
 */
function hostingFiles({ name, slug, deployTarget = 'none', database = 'none', installCommand, testCommand, buildCommand }) {
    const target = targetId(deployTarget);
    const db = databaseId(database);
    const install = command(installCommand, 'npm install');
    const test = command(testCommand, null);
    const build = command(buildCommand, null);
    const out = [{ path: '.github/workflows/ci.yml', text: ciWorkflow({ install, test }) }];
    const dbEnv = DATABASES[db].env;
    if (target !== 'none') {
        out.push({ path: '.github/workflows/deploy.yml', text: deployWorkflow({ target, install, test, build, env: dbEnv }) });
        if (target === 'flyio') out.push({ path: 'fly.toml', text: flyToml({ slug }) });
        if (target === 'netlify') out.push({ path: 'netlify.toml', text: '[build]\n  command = "npm run build --if-present"\n  publish = "public"\n' });
    }
    if (dbEnv.length) out.push({ path: '.env.example', text: dbEnv.map((k) => `${k}=`).join('\n') + '\n' });
    if (target !== 'none' || dbEnv.length) out.push({ path: 'DEPLOY.md', text: connectDoc({ name, target, database: db }) });
    return out;
}

/** fly.toml for a Node server that listens on PORT. Sleeps when idle, so it costs little while nobody uses it. */
function flyToml({ slug }) {
    const port = 8080;
    return `# Fly.io app. Change primary_region to one near you (fly platform regions).
app = "${slug.replace(/[^a-z0-9-]/g, '-').slice(0, 30)}"
primary_region = "den"

[env]
  PORT = "${port}"

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
`;
}

module.exports = { TARGETS, DATABASES, targetId, databaseId, catalog, hostingFiles };
