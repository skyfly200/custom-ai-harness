#!/usr/bin/env node
/**
 * validate-config — Phase 4 UTF-8 / non-breaking space validator
 *
 * Scans configuration directories for characters that silently break JSON
 * parsers in VS Code extensions: non-breaking spaces (U+00A0), zero-width
 * spaces (U+200B), en/em dashes used instead of hyphens, and other
 * non-standard whitespace that survives copy-paste from docs/browsers.
 *
 * Usage:
 *   node validate-config.js [dir ...]
 *   node validate-config.js          # defaults: .vscode .qwen .claude
 *
 * Exits 0 if clean, 1 if violations found.
 * Pass --fix to rewrite files with violations replaced by their ASCII equivalent.
 */

const fs   = require('fs');
const path = require('path');

const FIX_MODE     = process.argv.includes('--fix');
const USER_DIRS    = process.argv.slice(2).filter(a => !a.startsWith('--'));
const DEFAULT_DIRS = ['.vscode', '.qwen', '.claude'];
const SCAN_DIRS    = USER_DIRS.length ? USER_DIRS : DEFAULT_DIRS;

// Characters that silently corrupt JSON parsers in editors / extensions
const VIOLATIONS = [
    { name: 'non-breaking space',     re: / /g, fix: ' '  },
    { name: 'zero-width space',       re: /​/g, fix: ''   },
    { name: 'zero-width no-break sp', re: /﻿/g, fix: ''   },
    { name: 'en dash (use hyphen)',   re: /–/g, fix: '-'  },
    { name: 'em dash (use hyphen)',   re: /—/g, fix: '--' },
    { name: 'left smart quote',       re: /‘/g, fix: "'"  },
    { name: 'right smart quote',      re: /’/g, fix: "'"  },
    { name: 'left double smart quot', re: /“/g, fix: '"'  },
    { name: 'right double smart quo', re: /”/g, fix: '"'  },
];

const JSON_EXTS = new Set(['.json', '.jsonc', '.json5']);

let totalViolations = 0;

function scanFile(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return; // unreadable — skip
    }

    let fixed   = text;
    let fileHit = false;

    for (const { name, re, fix } of VIOLATIONS) {
        re.lastIndex = 0;
        const matches = text.match(re);
        if (!matches) continue;

        const lines = text.split('\n');
        lines.forEach((line, idx) => {
            re.lastIndex = 0;
            if (re.test(line)) {
                console.error(`  [L${idx + 1}] ${name}  →  ${filePath}`);
                totalViolations++;
                fileHit = true;
            }
        });

        if (FIX_MODE) fixed = fixed.replace(re, fix);
    }

    if (FIX_MODE && fileHit) {
        fs.writeFileSync(filePath, fixed, 'utf8');
        console.log(`  fixed: ${filePath}`);
    }
}

function scanDir(dir) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) return;

    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) {
            scanDir(full);
        } else if (entry.isFile() && JSON_EXTS.has(path.extname(entry.name))) {
            scanFile(full);
        }
    }
}

console.log(`Scanning: ${SCAN_DIRS.join(', ')}${FIX_MODE ? '  [--fix mode]' : ''}`);
SCAN_DIRS.forEach(scanDir);

if (totalViolations === 0) {
    console.log('OK — no invalid characters found.');
    process.exit(0);
} else {
    console.error(`\n${totalViolations} violation(s) found.${FIX_MODE ? ' Files rewritten.' : ' Run with --fix to auto-correct.'}`);
    process.exit(FIX_MODE ? 0 : 1);
}
