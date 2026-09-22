#!/usr/bin/env node
/**
 * caveman-compress — Phase 3 standing context trimmer
 *
 * Applies Headroom-style compression to workspace memory files such as
 * CLAUDE.md and .qwen/settings.json, minimising foundational token overhead
 * before execution.
 *
 * Usage:
 *   node caveman-compress.js [file ...]
 *   node caveman-compress.js          # defaults: CLAUDE.md .qwen/settings.json
 *
 * Edits files in-place; originals are backed up as <file>.bak
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_TARGETS = ['CLAUDE.md', path.join('.qwen', 'settings.json')];

const NOISE_RE = /(\r?\n){3,}/g;
const TRAIL_RE = /[ \t]+$/gm;
const DECOR_RE = /^[-=*#]{4,}.*$/gm;
// Collapse repeated blank comment lines in JSON / markdown
const BLANK_COMMENT_RE = /^(\s*\/\/\s*\n){2,}/gm;

function compressText(text) {
    return text
        .replace(DECOR_RE, '')
        .replace(BLANK_COMMENT_RE, '')
        .replace(TRAIL_RE, '')
        .replace(NOISE_RE, '\n\n')
        .trim() + '\n';
}

function compressJson(text) {
    try {
        const obj = JSON.parse(text);
        // Re-serialise with minimal spacing to drop all decorative whitespace
        return JSON.stringify(obj, null, 2) + '\n';
    } catch {
        // Not valid JSON — fall back to text compression
        return compressText(text);
    }
}

function processFile(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
        console.warn(`skip: ${filePath} (not found)`);
        return;
    }

    const original = fs.readFileSync(abs, 'utf8');
    const isJson   = abs.endsWith('.json');
    const compressed = isJson ? compressJson(original) : compressText(original);

    if (compressed === original) {
        console.log(`unchanged: ${filePath}`);
        return;
    }

    fs.writeFileSync(abs + '.bak', original, 'utf8');
    fs.writeFileSync(abs, compressed, 'utf8');

    const saved = original.length - compressed.length;
    const pct   = ((saved / original.length) * 100).toFixed(1);
    console.log(`compressed: ${filePath}  -${saved} chars (${pct}%)  [backup: ${filePath}.bak]`);
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
targets.forEach(processFile);
