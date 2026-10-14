const test = require('node:test');
const assert = require('node:assert/strict');
const { render, toSpeech } = require('../ui/markdown');

test('model output cannot inject HTML or script links', () => {
    const html = render('<img src=x onerror=alert(1)> [x](javascript:alert(1)) `<b>`');
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('href="javascript'));
    assert.match(html, /<code>&lt;b&gt;<\/code>/);
});

test('headings, emphasis, links and nested lists', () => {
    const html = render('## Plan\n\n**bold** and *it* and [docs](https://x.dev/a?b=1&c=2)\n\n- one\n  - two\n- [x] done');
    assert.match(html, /<h2>Plan<\/h2>/);
    assert.match(html, /<strong>bold<\/strong> and <em>it<\/em>/);
    assert.match(html, /<a href="https:\/\/x\.dev\/a\?b=1&amp;c=2"/);
    assert.match(html, /<ul><li>one<ul><li>two<\/li><\/ul><\/li><li class="task"><input type="checkbox" disabled checked> done<\/li><\/ul>/);
});

test('snake_case words are not italicised', () => {
    assert.equal(render('call my_func_name now'), '<p>call my_func_name now</p>');
});

test('tables keep their column alignment', () => {
    const html = render('| a | b |\n|---|--:|\n| 1 | 2 |');
    assert.match(html, /<th>a<\/th><th style="text-align:right">b<\/th>/);
    assert.match(html, /<td>1<\/td><td style="text-align:right">2<\/td>/);
});

test('code blocks get a language label, a copy button and escaped content, even before the fence closes', () => {
    const html = render('```js\nconst a = "<x>"; // hi\n```');
    assert.match(html, /<span>js<\/span><button type="button" class="copy-code"/);
    assert.match(html, /<span class="hl-kw">const<\/span> a = <span class="hl-str">&quot;&lt;x&gt;&quot;<\/span>; <span class="hl-com">\/\/ hi<\/span>/);
    assert.match(render('```py\nprint(1)'), /<code data-lang="py">print\(/);
});

test('read-aloud text drops markup, list numbers and code', () => {
    assert.equal(toSpeech('Here is **x**:\n\n1. First step\n2. Second step!\n\n```js\ncode()\n```\nsnake_case done.'),
        'Here is x. First step. Second step! (code block). snake_case done.');
});
