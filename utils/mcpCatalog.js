// Popular MCP servers to add from the Tools page. `spec` is the entry written
// to mcp-servers.json. `ready` entries need nothing from you and are added on
// one click; the others open the form with `spec` filled in and `needs` saying
// what to change first.
'use strict';

module.exports = [
    { id: 'filesystem', name: 'Filesystem', description: 'Read, write and search files in a folder you choose.', needs: 'Change the folder at the end of the arguments.',
        spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${HOME}/Documents'] } },
    { id: 'fetch', name: 'Fetch', description: 'Download a web page and turn it into text.', ready: true, needs: 'Needs uv installed (the uvx command).',
        spec: { command: 'uvx', args: ['mcp-server-fetch'] } },
    { id: 'git', name: 'Git', description: 'Read a repo: status, log, diffs, branches (and commit, if you allow it).', needs: 'Change the repository path.',
        spec: { command: 'uvx', args: ['mcp-server-git', '--repository', '${HARNESS_DIR}'] } },
    { id: 'github', name: 'GitHub', description: 'Issues, pull requests, code search and files on GitHub.', needs: 'Put a GitHub token in .env as GITHUB_TOKEN.',
        spec: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } } },
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
        spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } } },
    { id: 'jev-files', name: 'Jev file questions', description: "Ask Jev yes/no or 0-10 questions about a file on this computer (this harness's own tool).", ready: true, needs: 'Needs the harness running.',
        spec: { command: 'node', args: ['scripts/jev-files-mcp.js'] } },
];
