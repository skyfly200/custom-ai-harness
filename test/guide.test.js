'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.join(__dirname, '..', 'ui');

test('every page guide is a book button that opens a template, after dialogs.js', () => {
  for (const f of fs.readdirSync(ui).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ui, f), 'utf8');
    const buttons = [...html.matchAll(/<button[^>]*class="guide-btn"[^>]*data-guide="([^"]+)"/g)].map((m) => m[1]);
    for (const id of buttons) {
      assert.ok(html.includes(`<template id="${id}"`), `${f} needs <template id="${id}">`);
      assert.ok(html.indexOf('src="dialogs.js"') < html.indexOf('src="guide.js"'), `${f} loads guide.js after dialogs.js`);
    }
  }
});

test('no page keeps an inline <details> guide', () => {
  for (const f of fs.readdirSync(ui).filter((x) => x.endsWith('.html'))) {
    assert.ok(!/class="guide card"/.test(fs.readFileSync(path.join(ui, f), 'utf8')), `${f} should use the book button`);
  }
});
