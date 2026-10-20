#!/usr/bin/env node
// MCP server that lets an agent ask Jev about a file without reading it into
// its own context (levels 8 and 9 of the "10 levels of Jev"). The tool reads
// the file locally, the harness's POST /v1/jev/ask has Jev answer, and only
// the answer comes back. A 40,000-line log costs a few lines of reply.
//
//   claude mcp add jev-files -- node /path/to/custom-ai-harness/scripts/jev-files-mcp.js
//
// Tools: ask_jev_filebool (yes/no), ask_jev_filescale (0 to 1) and
// ask_jev_files (yes/no across up to 20 files, listing the ones that say yes).
// HARNESS_URL (default http://localhost:3000) and HARNESS_PASSWORD say where
// the harness is; HARNESS_FILE_ROOTS limits which folders can be read.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { askFile, describe, percent } = require('../utils/jevFiles');

const BASE = (process.env.HARNESS_URL || 'http://localhost:3000').replace(/\/$/, '');
const MAX_FILES = 20;

async function post(body) {
    const headers = { 'content-type': 'application/json' };
    if (process.env.HARNESS_PASSWORD) headers['x-harness-password'] = process.env.HARNESS_PASSWORD;
    let res;
    try {
        res = await fetch(`${BASE}/v1/jev/ask`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    } catch (err) {
        throw new Error(`the harness at ${BASE} is not reachable (${err.cause?.code || err.message})`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `the harness answered HTTP ${res.status}`);
    return json;
}

const text = (t, isError = false) => ({ isError, content: [{ type: 'text', text: t }] });
const failure = (err) => text(`Error: ${err.message}`, true);

const server = new McpServer({ name: 'jev-files', version: '1.0.0' });

server.registerTool('ask_jev_filebool', {
    description: 'Ask Jev a yes/no question about a file without reading the file yourself. Use it instead of opening a large file when you only need a fact about it, such as "Does this file read environment variables?". Returns yes or no with Jev\'s confidence and roughly where it found the answer.',
    inputSchema: { path: z.string().describe('File to ask about'), question: z.string().describe('A yes/no question about the whole file') },
}, async ({ path, question }) => {
    try { return text(describe(path, await askFile(post, path, question, 'bool'))); } catch (err) { return failure(err); }
});

server.registerTool('ask_jev_filescale', {
    description: 'Ask Jev to rate a file from 0 to 1 against a statement, without reading the file yourself. Phrase the question as a statement, such as "This code is hard to follow" or "This file handles user authentication". 0 means not at all, 1 means completely.',
    inputSchema: { path: z.string().describe('File to rate'), question: z.string().describe('The statement to rate') },
}, async ({ path, question }) => {
    try { return text(describe(path, await askFile(post, path, question, 'scale'))); } catch (err) { return failure(err); }
});

server.registerTool('ask_jev_files', {
    description: `Ask the same yes/no question about up to ${MAX_FILES} files and get back only the ones where Jev says yes, strongest first. Use it to find which files matter before reading any of them, such as "Does this file define an HTTP route?".`,
    inputSchema: {
        paths: z.array(z.string()).min(1).max(MAX_FILES).describe('Files to ask about'),
        question: z.string().describe('A yes/no question about each file'),
        threshold: z.number().min(0).max(1).optional().describe('How sure Jev must be to count as yes (default 0.5)'),
    },
}, async ({ paths, question, threshold }) => {
    const settled = await Promise.all(paths.map(async (p) => {
        try { return { path: p, result: await askFile(post, p, question, 'bool', threshold === undefined ? {} : { threshold }) }; } catch (err) { return { path: p, error: err.message }; }
    }));
    const yes = settled.filter((s) => s.result?.answer).sort((a, b) => b.result.score - a.result.score);
    const errors = settled.filter((s) => s.error);
    const lines = [`${yes.length} of ${paths.length} files: yes.`];
    for (const s of yes) lines.push(`${s.path}: ${percent(s.result.score)}, strongest around line ${s.result.best.line}`);
    for (const s of errors) lines.push(`${s.path}: not asked (${s.error})`);
    return text(lines.join('\n'), errors.length === paths.length);
});

server.connect(new StdioServerTransport());
