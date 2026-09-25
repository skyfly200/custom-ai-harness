/**
 * tokenCounter.js — Token counting with baseline + learned adjustment
 *
 * Usage:
 *   const { countTokens, isEnabled, setEnabled, recordObservation } = require('./utils/tokenCounter');
 *
 * Environment variables:
 *   TOKEN_COUNTING_ENABLED   — "true" / "false" (default: "false")
 *   TOKEN_BASELINE_FACTOR    — baseline multiplier (default: 1.0)
 *   TOKEN_LEARNING_RATE      — how fast to adapt from observations (default: 0.1)
 *
 * The counter starts with a naive character‑based estimate (chars / 4 ≈ tokens).
 * Each time you call `recordObservation(actualTokens, estimatedTokens)` it
 * adjusts an internal correction factor so future estimates get closer to reality.
 */

const fs = require('fs');
const path = require('path');

// Config — can be overridden via env
const ENABLED = (process.env.TOKEN_COUNTING_ENABLED ?? 'false').toLowerCase() === 'true';
let baselineFactor = parseFloat(process.env.TOKEN_BASELINE_FACTOR) || 1.0;
const learningRate = parseFloat(process.env.TOKEN_LEARNING_RATE) || 0.1;

// Persisted correction factor (starts at 1.0, updated from observations)
const STATE_FILE = path.join(__dirname, 'tokenCounterState.json');
let correctionFactor = 1.0;

try {
    if (fs.existsSync(STATE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        correctionFactor = typeof saved.correctionFactor === 'number' ? saved.correctionFactor : 1.0;
    }
} catch {
    // ignore — fall back to 1.0
}

function persist() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ correctionFactor }, null, 2), 'utf8');
    } catch {}
}

/**
 * Rough character‑based estimate (chars / 4).
 * Multiply by baselineFactor * correctionFactor to get the current estimate.
 */
function naiveEstimate(text) {
    if (typeof text !== 'string') text = JSON.stringify(text);
    return Math.ceil(text.length / 4);
}

/**
 * Public estimate function — returns the current best guess.
 */
function countTokens(text) {
    if (!ENABLED) return 0;
    const naive = naiveEstimate(text);
    return Math.round(naive * baselineFactor * correctionFactor);
}

/**
 * Call this when you *know* the real token count (e.g., from the model's response headers).
 * It nudges the correction factor toward actual / estimated.
 */
function recordObservation(actualTokens, estimatedTokens) {
    if (!ENABLED || estimatedTokens <= 0) return;
    const ratio = actualTokens / estimatedTokens;
    // Exponential moving average toward the observed ratio
    correctionFactor = correctionFactor * (1 - learningRate) + ratio * learningRate;
    persist();
}

/**
 * Toggle the whole system on/off at runtime.
 */
function setEnabled(on) {
    // Note: this only affects future calls; it does not change the env var.
    Object.defineProperty(module.exports, 'isEnabled', { value: !!on, writable: true });
}

module.exports = {
    countTokens,
    isEnabled: ENABLED,
    setEnabled,
    recordObservation,
    // Exposed for testing / debugging
    _internal: {
        getCorrectionFactor: () => correctionFactor,
        getBaselineFactor: () => baselineFactor,
        setBaselineFactor: (v) => { baselineFactor = v; },
    }
};