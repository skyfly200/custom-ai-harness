// Echo MCP server that hangs without answering the first time it runs
// (a marker file records that), like npx fetching a package on a cold cache.
const fs = require('node:fs');
const marker = process.env.FLAKY_MARKER;
if (marker && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'x');
    setInterval(() => {}, 1000);
} else {
    require('./echo-mcp-server.js');
}
