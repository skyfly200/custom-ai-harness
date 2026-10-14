// Markdown to HTML for the chat page, with no dependencies. Every piece of
// model text is escaped before any tag is added, so a reply can't inject HTML.
// Covers what models write: headings, lists (nested, numbered, task), quotes,
// tables, rules, fenced code with a language label, and inline code, bold,
// italic, strikethrough and links. An unclosed fence (mid-stream) still renders
// as code. Loaded by chat.html as a script and by the tests with require().
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---- code highlighting: comments, strings, numbers and keywords --------
  const KEYWORDS = new Set(('as async await break case catch class const continue def default del do elif else enum export extends ' +
    'false fn for from func function if impl import in interface is lambda let loop match mut new nil None null pass ' +
    'private protected pub public raise return self static struct super switch this throw true True False try type ' +
    'typeof undefined use var void while with yield package go defer select end then local elseif not and or ' +
    'echo fi esac done param foreach').split(' '));
  const HASH_COMMENTS = /^(py|python|sh|bash|zsh|shell|console|ps1|powershell|pwsh|yaml|yml|toml|rb|ruby|r|dockerfile|makefile|ini|conf|perl|pl|elixir|ex)$/;
  const SQL_LIKE = /^(sql|lua|haskell|hs)$/;

  function highlight(code, lang) {
    lang = (lang || '').toLowerCase();
    if (!lang || /^(text|txt|plain|plaintext|md|markdown|diff|output|log)$/.test(lang)) {
      if (lang === 'diff') return code.split('\n').map(l => /^[+]/.test(l) ? `<span class="hl-add">${esc(l)}</span>` : /^-/.test(l) ? `<span class="hl-del">${esc(l)}</span>` : esc(l)).join('\n');
      return esc(code);
    }
    const line = HASH_COMMENTS.test(lang) ? '#[^\\n]*' : SQL_LIKE.test(lang) ? '--[^\\n]*' : '\\/\\/[^\\n]*';
    const block = /^(html|xml|svg|vue)$/.test(lang) ? '<!--[\\s\\S]*?-->' : '\\/\\*[\\s\\S]*?\\*\\/';
    const re = new RegExp(`(${block}|${line})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const [tok, comment, str, num, word] = m;
      if (comment) out += `<span class="hl-com">${esc(tok)}</span>`;
      else if (str) out += `<span class="hl-str">${esc(tok)}</span>`;
      else if (num) out += `<span class="hl-num">${esc(tok)}</span>`;
      else if (word && KEYWORDS.has(word)) out += `<span class="hl-kw">${esc(tok)}</span>`;
      else out += esc(tok);
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }

  // ---- inline -------------------------------------------------------------
  function safeUrl(url) {
    const u = url.trim().replace(/&amp;/g, '&');
    return /^(https?:|mailto:)/i.test(u) ? esc(u) : null;
  }

  function inline(text) {
    const held = [];
    const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
    let s = String(text)
      // code spans first, so nothing inside them is formatted
      .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code.trim() || code)}</code>`));
    s = esc(s)
      .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (all, label, url) => {
        const href = safeUrl(url);
        return href ? hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">`) + label + hold('</a>') : all;
      })
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, (_, pre, url) => {
        const href = safeUrl(url);
        return href ? pre + hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`) : pre + url;
      })
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/ {2,}\n|\\\n/g, '<br>')
      .replace(/\n/g, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  }

  // ---- blocks -------------------------------------------------------------
  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  const indentOf = (s) => s.replace(/\t/g, '    ').match(/^ */)[0].length;
  const splitRow = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

  function codeBlock(code, lang) {
    const label = lang ? esc(lang) : 'code';
    return `<div class="code"><div class="code-head"><span>${label}</span><button type="button" class="copy-code" title="Copy code">Copy</button></div>` +
      `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${highlight(code, lang)}</code></pre></div>`;
  }

  function startsBlock(line, next) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) ||
      (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      let m = line.match(FENCE);
      if (m) {
        const fence = m[1], lang = m[2], body = [];
        i++;
        while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
        i++; // closing fence (or past the end while streaming)
        out.push(codeBlock(body.join('\n'), lang));
        continue;
      }
      if ((m = line.match(HEADING))) {
        const level = m[1].length;
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
        i++;
        continue;
      }
      if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) body.push(lines[i++].replace(QUOTE, ''));
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
        const cell = (tag, text, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(text ?? '')}</${tag}>`;
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(`<div class="table-scroll"><table><thead><tr>${head.map((h, k) => cell('th', h, k)).join('')}</tr></thead>` +
          `<tbody>${rows.map(r => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (LIST.test(line)) {
        const [html, next] = list(lines, i);
        out.push(html);
        i = next;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++]);
      out.push(`<p>${inline(para.join('\n'))}</p>`);
    }
    return out.join('');
  }

  // A list and everything indented under it. Returns [html, next line index].
  function list(lines, start) {
    const first = lines[start].match(LIST);
    const base = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let i = start, loose = false;
    while (i < lines.length) {
      const m = lines[i].match(LIST);
      if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
      const body = [m[3]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // a blank line continues the item only if indented content follows
          const after = lines.slice(i + 1).find(x => x.trim());
          if (after !== undefined && indentOf(after) > base) { body.push(''); loose = true; i++; continue; }
          if (after !== undefined && LIST.test(after) && indentOf(after.match(LIST)[1]) === base) loose = true;
          break;
        }
        const lm = l.match(LIST);
        if (lm && indentOf(lm[1]) <= base) break;
        if (!lm && indentOf(l) <= base && startsBlock(l, lines[i + 1])) break;
        body.push(l);
        i++;
      }
      items.push(body);
      while (i < lines.length && !lines[i].trim()) {
        const after = lines.slice(i).find(x => x.trim());
        const am = after && after.match(LIST);
        if (am && indentOf(am[1]) === base && /\d/.test(am[2]) === ordered) i++; else break;
      }
    }
    const html = items.map(body => {
      // dedent the item's continuation lines so nested blocks parse
      const [head, ...rest] = body;
      const pad = Math.min(...rest.filter(l => l.trim()).map(indentOf), Infinity);
      const inner = [head, ...rest.map(l => l.replace(/\t/g, '    ').slice(Number.isFinite(pad) ? pad : 0))];
      let task = '';
      const t = head.match(/^\[( |x|X)\]\s+/);
      if (t) { task = `<input type="checkbox" disabled${t[1] !== ' ' ? ' checked' : ''}> `; inner[0] = head.slice(t[0].length); }
      let content = blocks(inner);
      if (!loose) content = content.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      return `<li${task ? ' class="task"' : ''}>${task}${content}</li>`;
    }).join('');
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>${html}</${tag}>`, i];
  }

  function render(text) {
    return blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
  }

  // Plain text for reading aloud: no code, markup or link targets.
  function toSpeech(text) {
    return String(text ?? '')
      .replace(/```[\s\S]*?(```|$)/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
      .replace(/^\s*\|(.*)\|\s*$/gm, '$1')
      .replace(/\s*\|\s*/g, ', ')
      .replace(/(\*\*|~~|\*)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|\W)__?(?=\S)([^_]*?\S)__?(?!\w)/g, '$1$2')
      .replace(/([.!?:;,])?\s*\n+/g, (_, p) => (p && p !== ':' ? p + ' ' : '. '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  const api = { render, inline, highlight, toSpeech, escape: esc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
