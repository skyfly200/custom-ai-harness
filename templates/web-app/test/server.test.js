const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

test('the health check answers and the page loads', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<textarea id="message"/);
  } finally {
    server.close();
  }
});
