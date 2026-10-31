// Importing skills from the web: a link to a SKILL.md or other .md file, a GitHub repo or folder that holds
// SKILL.md files, or a gist. The server fetches them, so every address goes through the checks here: https on
// the standard port, no login in the address, public addresses only (checked again after each redirect, and the
// connection uses the address that was checked), a size limit and a time limit. The text is untrusted: the
// Skills page shows it in full before anything is saved, and the model only sees it once a person keeps it.
'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const claudeKit = require('./claudeKit');

const MAX_BYTES = 200 * 1024; // one file
const MAX_FILES = 25;         // skills taken from one repo folder or gist
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const GITHUB_HEADERS = { accept: 'application/vnd.github+json' };

// Addresses a server should never fetch from: loopback, private, link-local (cloud metadata), CGNAT, multicast, reserved.
const blocked = new net.BlockList();
for (const [net4, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(net4, bits, 'ipv4');
}
for (const [net6, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) {
  blocked.addSubnet(net6, bits, 'ipv6');
}

// "::ffff:10.0.0.1" (or its hex form) is the IPv4 address 10.0.0.1 written as IPv6: check that one.
function embeddedIPv4(ip) {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const [a, b] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return [a >> 8, a & 255, b >> 8, b & 255].join('.');
}

function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (/^::ffff:/i.test(ip)) {
    const v4 = embeddedIPv4(ip);
    return v4 !== null && isPublicAddress(v4);
  }
  return !blocked.check(ip, 'ipv6');
}

const refused = (what = 'That is not a public web address.') => Object.assign(new Error(what), { status: 400 });

// The address as an https URL on the standard port, or an error saying why not.
function httpsUrl(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { throw Object.assign(new Error('That is not a web address.'), { status: 400 }); }
  if (u.protocol !== 'https:') throw Object.assign(new Error('Only https:// addresses can be imported.'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Addresses with a login in them cannot be imported.'), { status: 400 });
  if (u.port && u.port !== '443') throw Object.assign(new Error('Only the standard https port (443) can be imported.'), { status: 400 });
  return u;
}

// The one address the connection will use. Every address the name has must be public, so a name cannot
// point somewhere internal on one lookup and somewhere public on the next.
async function publicAddress(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw refused();
    return { address: host, family: net.isIP(host) };
  }
  let records = [];
  try { records = await lookup(host, { all: true }); } catch { records = []; }
  if (!records.length || records.some((r) => !isPublicAddress(r.address))) throw refused();
  return records[0];
}

// One request to the address that was checked. Resolves { status, type, text } or { status, location } for a redirect.
function request(u, address, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(u, {
      method: 'GET',
      headers: { 'user-agent': 'custom-ai-harness', accept: 'text/plain, text/markdown, application/json;q=0.9, */*;q=0.5', ...headers },
      // Node 20+ asks for every address (options.all) when it connects, and then wants an array back. The
      // connection still goes only to the address that was checked above.
      lookup: (_host, options, done) => (options?.all
        ? done(null, [{ address: address.address, family: address.family }])
        : done(null, address.address, address.family)),
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ status: res.statusCode, location: res.headers.location });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode });
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(); reject(Object.assign(new Error('That file is larger than 200 KB.'), { status: 400 })); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: 200, type: res.headers['content-type'] || '', text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('The address took too long to answer.'), { status: 504 })));
    req.on('error', reject);
    req.end();
  });
}

// The text at an https address. transport and lookup are injectable so the tests can run without a network.
async function getText(input, { headers = {}, transport = request, lookup = dns.lookup, redirects = 0 } = {}) {
  const u = httpsUrl(input);
  const address = await publicAddress(u.hostname, lookup);
  const r = await transport(u, address, headers);
  if (r.location) {
    if (redirects >= MAX_REDIRECTS) throw Object.assign(new Error('The address redirected too many times.'), { status: 400 });
    return getText(new URL(r.location, u), { headers, transport, lookup, redirects: redirects + 1 });
  }
  if (r.status !== 200) throw Object.assign(new Error(`The address answered HTTP ${r.status}.`), { status: r.status === 404 ? 404 : 502 });
  if (/text\/html/i.test(r.type)) throw Object.assign(new Error('That is a web page, not a skill file. Paste a link to the raw .md file, a GitHub folder or repo, or a gist.'), { status: 400 });
  if (Buffer.byteLength(r.text) > MAX_BYTES) throw Object.assign(new Error('That file is larger than 200 KB.'), { status: 400 });
  if (r.text.includes('\u0000')) throw Object.assign(new Error('That is not a text file.'), { status: 400 });
  return r.text;
}

// One skill from a file's text: its frontmatter name and description, else the fallback name.
function itemFrom(text, fallbackName, url, page) {
  const { meta, body } = claudeKit.parse(text);
  return {
    name: meta.name || fallbackName,
    description: (meta.description || '').slice(0, 200),
    body,
    url,
    page,
    ...(body ? {} : { error: 'No instructions in it.' }),
  };
}

// A file that may not load: the list still shows it, with the reason, and it cannot be imported.
async function loadItem(url, page, fallbackName, opts) {
  try {
    return itemFrom(await getText(url, opts), fallbackName, url, page);
  } catch (err) {
    return { name: fallbackName, description: '', body: '', url, page, error: err.message };
  }
}

// What an address points at: a GitHub repo or folder, a gist, a GitHub file, or a plain file. Others are refused.
function githubTarget(u) {
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (u.hostname === 'gist.github.com') {
    const id = parts[parts.length - 1];
    return parts.length <= 2 && /^[0-9a-f]+$/i.test(id || '') ? { kind: 'gist', id } : { kind: 'unsupported' };
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const [owner, repo, mode, ref, ...rest] = parts;
  const name = repo?.replace(/\.git$/, '');
  if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return { kind: 'unsupported' };
  if (!mode) return { kind: 'repo', owner, repo: name, ref: null, path: '' };
  if (mode === 'tree' && ref) return { kind: 'repo', owner, repo: name, ref, path: rest.join('/') };
  if (mode === 'blob' && ref && rest.length) {
    return { kind: 'file', url: `https://raw.githubusercontent.com/${[owner, name, ref, ...rest].map(encodeURIComponent).join('/')}` };
  }
  return { kind: 'unsupported' };
}

// Every SKILL.md under the folder, from one tree listing (one API call, plus one for the default branch).
async function fromRepo({ owner, repo, ref, path }, opts) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const branch = ref || JSON.parse(await getText(api, { ...opts, headers: GITHUB_HEADERS })).default_branch;
  const tree = JSON.parse(await getText(`${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { ...opts, headers: GITHUB_HEADERS }));
  const prefix = path ? `${path.replace(/\/+$/, '')}/` : '';
  const found = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && e.path.split('/').pop() === 'SKILL.md');
  if (!found.length) throw Object.assign(new Error('No SKILL.md files found there.'), { status: 404 });
  const items = await Promise.all(found.slice(0, MAX_FILES).map((e) => {
    const folder = e.path.split('/').slice(-2, -1)[0] || repo;
    const segments = (...parts) => parts.flatMap((p) => p.split('/')).map(encodeURIComponent).join('/');
    const rawUrl = `https://raw.githubusercontent.com/${segments(owner, repo, branch, e.path)}`;
    const page = `https://github.com/${segments(owner, repo, 'blob', branch, e.path)}`;
    return loadItem(rawUrl, page, folder, opts);
  }));
  return { kind: 'repo', truncated: tree.truncated || found.length > MAX_FILES, items };
}

// Every .md file in the gist; the ones that are not skills show up with their reason, so the page can skip them.
async function fromGist(id, opts) {
  const gist = JSON.parse(await getText(`https://api.github.com/gists/${id}`, { ...opts, headers: GITHUB_HEADERS }));
  const files = Object.values(gist.files || {}).filter((f) => /\.(md|markdown|txt)$/i.test(f.filename));
  if (!files.length) throw Object.assign(new Error('No .md files in that gist.'), { status: 404 });
  const page = `https://gist.github.com/${id}`;
  const items = await Promise.all(files.slice(0, MAX_FILES).map((f) => loadItem(f.raw_url, page, f.filename.replace(/\.(md|markdown|txt)$/i, ''), opts)));
  return { kind: 'gist', truncated: files.length > MAX_FILES, items };
}

// The skills at a link: { kind, truncated, items: [{ name, description, body, url, page, error? }] }.
async function fetchSkills(input, opts = {}) {
  const u = httpsUrl(input);
  const target = githubTarget(u);
  if (target?.kind === 'unsupported') throw Object.assign(new Error('Paste a link to a SKILL.md file, a GitHub folder or repo, or a gist.'), { status: 400 });
  if (target?.kind === 'repo') return fromRepo(target, opts);
  if (target?.kind === 'gist') return fromGist(target.id, opts);
  const fallback = decodeURIComponent(u.pathname.split('/').pop() || 'skill').replace(/\.(md|markdown|txt)$/i, '');
  const item = await loadItem(target?.kind === 'file' ? target.url : u.href, u.href, fallback, opts);
  if (item.error) throw Object.assign(new Error(item.error), { status: 400 });
  return { kind: 'file', truncated: false, items: [item] };
}

module.exports = { fetchSkills, getText, httpsUrl, isPublicAddress, githubTarget, request, MAX_BYTES, MAX_FILES };
