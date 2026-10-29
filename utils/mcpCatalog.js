// Popular MCP servers to add from the Tools page. `spec` is the entry written
// to mcp-servers.json. `ready` entries need nothing from you and are added on
// one click; the others open the form with `spec` filled in and `needs` saying
// what to change first.
//
// `inputs` is what the setup wizard asks for. Each says where its answer goes
// (`into`: an argument position, an env variable, or a header with a prefix),
// what to type, and where to get it (`get`: a link and plain steps). The
// answer is saved in the entry and hidden afterwards.
'use strict';

module.exports = [
    { id: 'filesystem', name: 'Filesystem', description: 'Read, write and search files in a folder you choose.', needs: 'Change the folder at the end of the arguments.',
        inputs: [{ id: 'folder', label: 'Folder to share with the model', kind: 'folder', value: '${HOME}/Documents', into: { arg: 2 }, help: 'The model can read, write and search everything inside this folder, and nothing outside it. On Windows, type the path like C:\\Users\\you\\Documents.' }],
        spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${HOME}/Documents'] } },
    { id: 'fetch', name: 'Fetch', description: 'Download a web page and turn it into text.', ready: true, needs: 'Needs uv installed (the uvx command).',
        spec: { command: 'uvx', args: ['mcp-server-fetch'] } },
    { id: 'git', name: 'Git', description: 'Read a repo: status, log, diffs, branches (and commit, if you allow it).', needs: 'Change the repository path.',
        inputs: [{ id: 'repo', label: 'Git repository folder', kind: 'folder', value: '${HARNESS_DIR}', into: { arg: 2 }, help: 'The folder of the repo to read. It must contain a .git folder. ${HARNESS_DIR} is this harness itself.' }],
        spec: { command: 'uvx', args: ['mcp-server-git', '--repository', '${HARNESS_DIR}'] } },
    { id: 'github', name: 'GitHub', description: 'Issues, pull requests, code search and files on GitHub.', needs: 'Put a GitHub token in .env as GITHUB_TOKEN.',
        inputs: [{ id: 'token', label: 'GitHub access token', kind: 'secret', into: { header: 'Authorization', prefix: 'Bearer ' },
            get: { url: 'https://github.com/settings/personal-access-tokens/new', label: 'Create a token on GitHub', steps: ['Name it (for example "Bright Chat") and pick an expiry.', 'Under Repository access choose the repos the model may use.', 'Under Permissions give Contents, Issues and Pull requests read access (write only if you want it to change things).', 'Press Generate token and copy it here.'] } }],
        spec: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } } },
    { id: 'vercel', name: 'Vercel', description: 'Projects, deployments, build and runtime logs, domains and environment variables on Vercel. Asks before anything that changes your account.',
        needs: 'Create a Vercel access token (Account Settings, Tokens) and put it in .env as VERCEL_TOKEN. Vercel may only accept sign-in from approved apps; Test connection says if it refuses the token.',
        inputs: [{ id: 'token', label: 'Vercel access token', kind: 'secret', into: { header: 'Authorization', prefix: 'Bearer ' },
            get: { url: 'https://vercel.com/account/tokens', label: 'Create a token on Vercel', steps: ['Press Create Token, name it and choose its scope.', 'Copy the token here. Vercel shows it only once.'] } }],
        spec: { type: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' }, askBefore: 'writes' } },
    { id: 'memory', name: 'Memory', description: 'A small knowledge graph the model can save facts into and recall.', ready: true,
        spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
    { id: 'sequential-thinking', name: 'Sequential thinking', description: 'Lets the model work through a problem in revisable steps.', ready: true,
        spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } },
    { id: 'time', name: 'Time', description: 'Current time and time zone conversion.', ready: true, needs: 'Needs uv installed (the uvx command).',
        spec: { command: 'uvx', args: ['mcp-server-time'] } },
    { id: 'playwright', name: 'Playwright', description: 'Drive a real browser: open pages, click, read, take screenshots.', ready: true,
        spec: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    { id: 'context7', name: 'Context7', description: 'Up-to-date library documentation for coding questions.', ready: true,
        spec: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
    { id: 'brave-search', name: 'Brave Search', description: 'Web search through the Brave Search API.', needs: 'Put a Brave API key in .env as BRAVE_API_KEY.',
        inputs: [{ id: 'key', label: 'Brave Search API key', kind: 'secret', into: { env: 'BRAVE_API_KEY' },
            get: { url: 'https://brave.com/search/api/', label: 'Get a Brave Search API key', steps: ['Sign up for a plan (there is a free one).', 'Open API Keys in the dashboard and copy a key here.'] } }],
        spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } } },
    { id: 'jev-files', name: 'Jev file questions', description: "Ask Jev yes/no or 0-10 questions about a file on this computer (this harness's own tool).", ready: true, needs: 'Needs the harness running.',
        spec: { command: 'node', args: ['scripts/jev-files-mcp.js'] } },
];
