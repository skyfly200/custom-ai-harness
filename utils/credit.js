// Guest credit: a hard lifetime dollar cap that can't be overshot by concurrent requests.
//
// Before a request goes to the Gateway the worst case it could cost is *reserved* against the cap in one
// atomic UPDATE (it only succeeds while spent + reserved + amount <= cap). When the reply is done the
// reservation is swapped for the real cost. A request that is refused never reaches a model; if the
// database doesn't answer, the error propagates and the caller refuses the request (fails closed).
// Amounts are whole millionths of a dollar. A reservation nobody settled (the process died) is charged
// in full when it expires, so a crash can only cost the guest credit, never the owner.
'use strict';

const crypto = require('crypto');
const db = require('./db');

const MICRO = 1e6;
const HOLD_MINUTES = 20;
const toMicro = (usd) => Math.round(Number(usd) * MICRO);
const toUsd = (micro) => Number(micro) / MICRO;
// round a dollar amount up to the next micro-dollar, so a reservation is never short by rounding
const ceilMicro = (usd) => Math.ceil(Number(usd) * MICRO - 1e-9);

/** Make the account (or leave an existing one, and its spending, alone). */
async function open(owner, capUsd) {
    const cap = toMicro(capUsd);
    if (!(cap >= 0)) throw new Error('the cap must be a dollar amount of 0 or more');
    await db.query(
        'INSERT INTO credit_accounts (owner, cap_micro) VALUES ($1, $2) ON CONFLICT (owner) DO UPDATE SET cap_micro = EXCLUDED.cap_micro',
        [owner, cap]);
}

/** Make the account if there is none; an existing one keeps its cap and spending. */
async function ensure(owner, capUsd) {
    const cap = toMicro(capUsd);
    if (!(cap >= 0)) throw new Error('the cap must be a dollar amount of 0 or more');
    await db.query('INSERT INTO credit_accounts (owner, cap_micro) VALUES ($1, $2) ON CONFLICT (owner) DO NOTHING', [owner, cap]);
}

async function setCap(owner, capUsd) {
    const cap = toMicro(capUsd);
    if (!(cap >= 0)) throw new Error('the cap must be a dollar amount of 0 or more');
    const r = await db.query('UPDATE credit_accounts SET cap_micro = $2 WHERE owner = $1 RETURNING owner', [owner, cap]);
    if (!r.rows.length) throw new Error('that user has no credit account');
}

async function forget(owner) {
    await db.query('DELETE FROM credit_holds WHERE owner = $1', [owner]);
    await db.query('DELETE FROM credit_accounts WHERE owner = $1', [owner]);
}

/** { capUsd, spentUsd, reservedUsd, leftUsd } or null when there is no account. */
async function get(owner) {
    const { rows } = await db.query('SELECT cap_micro, spent_micro, reserved_micro FROM credit_accounts WHERE owner = $1', [owner]);
    return rows[0] ? describe(rows[0]) : null;
}

function describe(r) {
    const cap = Number(r.cap_micro), spent = Number(r.spent_micro), reserved = Number(r.reserved_micro);
    return { capUsd: toUsd(cap), spentUsd: toUsd(spent), reservedUsd: toUsd(reserved), leftUsd: toUsd(Math.max(0, cap - spent - reserved)) };
}

async function all() {
    const { rows } = await db.query('SELECT owner, cap_micro, spent_micro, reserved_micro FROM credit_accounts');
    return Object.fromEntries(rows.map((r) => [r.owner, describe(r)]));
}

/**
 * Hold `micro` against the cap. Resolves the hold's id, or null when the credit can't cover it.
 * Throws if the database can't be reached: the caller must refuse the request then.
 */
async function reserve(owner, micro) {
    const amount = Math.max(0, Math.ceil(micro));
    const id = crypto.randomBytes(12).toString('hex');
    const { rows } = await db.query(
        `WITH upd AS (
           UPDATE credit_accounts SET reserved_micro = reserved_micro + $2
           WHERE owner = $1 AND spent_micro + reserved_micro + $2 <= cap_micro
           RETURNING owner)
         INSERT INTO credit_holds (id, owner, amount_micro, expires_at)
         SELECT $3, owner, $2, now() + ($4::text || ' minutes')::interval FROM upd RETURNING id`,
        [owner, amount, id, String(HOLD_MINUTES)]);
    return rows.length ? id : null;
}

/** Swap a hold for what the request really cost. A hold that already expired was charged in full. */
async function settle(id, costMicro) {
    const cost = Math.max(0, Math.ceil(costMicro));
    await db.query(
        `WITH h AS (DELETE FROM credit_holds WHERE id = $1 RETURNING owner, amount_micro)
         UPDATE credit_accounts a SET reserved_micro = GREATEST(0, a.reserved_micro - h.amount_micro), spent_micro = a.spent_micro + $2
         FROM h WHERE a.owner = h.owner`,
        [id, cost]);
}

/** Charge and clear the holds nobody settled. Returns how many. */
async function sweep() {
    const { rows } = await db.query(
        `WITH d AS (DELETE FROM credit_holds WHERE expires_at < now() RETURNING owner, amount_micro),
         s AS (SELECT owner, SUM(amount_micro) AS amt FROM d GROUP BY owner),
         u AS (UPDATE credit_accounts a SET reserved_micro = GREATEST(0, a.reserved_micro - s.amt), spent_micro = a.spent_micro + s.amt
               FROM s WHERE a.owner = s.owner RETURNING a.owner)
         SELECT count(*) AS n FROM d`);
    return Number(rows[0]?.n || 0);
}

let timer = null;
/** Sweep every minute while the server runs. */
function startSweeper() {
    if (timer) return;
    timer = setInterval(() => sweep().catch((err) => console.warn(`[credit] sweep failed: ${err.message}`)), 60000);
    timer.unref();
}

module.exports = { open, ensure, setCap, forget, get, all, reserve, settle, sweep, startSweeper, toMicro, toUsd, ceilMicro, MICRO };
