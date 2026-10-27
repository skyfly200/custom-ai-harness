// Escalation: when a run's model fails, answers with nothing, or a Verifier says
// FAIL, the run asks for more effort and tries again. The harness turns effort
// into a higher score, so the next request lands on a stronger tier; the run's
// maxTier (x-harness-max-tier) still caps how high that can go, so cost stays
// where the person set it.
'use strict';

const LADDER = ['min', 'low', 'medium', 'high', 'max'];
const MAX_BUMPS = 2; // how many rungs a run may climb

/** The effort name `bumps` rungs above `base` (a name from LADDER, or blank for medium). */
function effortAfter(base, bumps) {
    const at = Math.max(0, LADDER.indexOf(base || 'medium'));
    return LADDER[Math.min(LADDER.length - 1, at + bumps)];
}

/** Whether a run may still climb: escalation is on and the rungs are not used up. */
function canClimb(run, base = run.effort) {
    return run.escalate !== false && (run.bumps || 0) < MAX_BUMPS && effortAfter(base, run.bumps || 0) !== 'max';
}

/** Failures worth a stronger model: server trouble, nothing in the reply. Not a bad request. */
function worthEscalating(err) {
    return Boolean(err?.escalatable);
}

module.exports = { LADDER, MAX_BUMPS, effortAfter, canClimb, worthEscalating };
