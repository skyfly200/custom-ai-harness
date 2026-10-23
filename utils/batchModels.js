// Which OpenRouter models take its Batch API (about half price, results within
// 24 h). The catalog has no field for it, so data/batch-models.json lists them
// by hand: exact ids, or 'vendor/*'.

const fs = require('fs');
const path = require('path');

const FILE = process.env.HARNESS_BATCH_MODELS_FILE || path.join(__dirname, '..', 'data', 'batch-models.json');

function load(file = FILE) {
    try {
        const list = JSON.parse(fs.readFileSync(file, 'utf8')).models;
        return Array.isArray(list) ? list.filter(s => typeof s === 'string').map(s => s.trim().toLowerCase()) : [];
    } catch { return []; }
}

function isBatch(id, list) {
    const key = String(id || '').toLowerCase().replace(/:free$/, '');
    return list.some(p => (p.endsWith('/*') ? key.startsWith(p.slice(0, -1)) : p.replace(/:free$/, '') === key));
}

/** Mark `batch: true` on each catalog model the list names. */
function mark(models, list = load()) {
    return (models || []).map(m => ({ ...m, batch: isBatch(m.id, list) }));
}

module.exports = { load, isBatch, mark, FILE };
