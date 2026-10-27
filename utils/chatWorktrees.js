'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WORKTREES_DIR = path.resolve(process.env.CHAT_WORKTREES_DIR || path.join(__dirname, '..', 'data', 'chat-worktrees'));
const pending = new Map();

function git(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).trim()));
            resolve(String(stdout).trim());
        });
    });
}

function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function chatIdOf(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('a valid chat id is required to create its working tree');
    return id;
}

async function create(repoPath, chatId) {
    if (typeof repoPath !== 'string' || !repoPath.trim()) throw new Error('a git repository is required');
    const id = chatIdOf(chatId);
    const requested = path.resolve(repoPath.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
    let repo;
    try {
        repo = await git(requested, ['rev-parse', '--show-toplevel']);
    } catch (err) {
        throw new Error(`${requested} is not inside a git repository: ${err.message}`);
    }
    repo = path.resolve(repo);
    const key = `${repo}\0${id}`;
    if (pending.has(key)) return pending.get(key);

    const creating = (async () => {
        const identity = hash(key);
        const parent = path.join(WORKTREES_DIR, hash(repo));
        const dir = path.join(parent, identity);
        const branch = `harness/chat-${identity}`;
        fs.mkdirSync(parent, { recursive: true });

        if (fs.existsSync(dir)) {
            const actual = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '');
            const actualBranch = actual ? await git(dir, ['branch', '--show-current']).catch(() => '') : '';
            if (actual && path.resolve(actual) === path.resolve(dir) && actualBranch === branch) {
                return { path: dir, name: path.basename(repo), branch, source: repo };
            }
            throw new Error(`chat working tree path exists but is not its expected Git worktree: ${dir}`);
        }

        const branchExists = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
        if (branchExists) {
            await git(repo, ['worktree', 'prune']);
            await git(repo, ['worktree', 'add', '-q', dir, branch]);
        } else {
            await git(repo, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
        }
        return { path: dir, name: path.basename(repo), branch, source: repo };
    })();
    pending.set(key, creating);
    try {
        return await creating;
    } finally {
        pending.delete(key);
    }
}

module.exports = { create, WORKTREES_DIR };
