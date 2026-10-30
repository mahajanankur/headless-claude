'use strict';

/** Job lifecycle states (see .claude/rules/backend.md §11). */
const JOB_STATUS = Object.freeze({
    QUEUED: 'queued',
    CLAIMED: 'claimed',
    PROVISIONING: 'provisioning',
    RUNNING: 'running',
    WAITING_LIMIT: 'waiting_limit',
    CANCELLING: 'cancelling',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    TIMED_OUT: 'timed_out',
    NEEDS_REVIEW: 'needs_review',
    CANCELLED: 'cancelled',
});

const S = JOB_STATUS;

const TERMINAL_STATUSES = Object.freeze([S.SUCCEEDED, S.FAILED, S.TIMED_OUT, S.NEEDS_REVIEW, S.CANCELLED]);

/** States that hold a worker slot (a lease is held while in these). */
const ACTIVE_STATUSES = Object.freeze([S.CLAIMED, S.PROVISIONING, S.RUNNING, S.CANCELLING]);

/** Allowed transitions: from → [to]. */
const TRANSITIONS = Object.freeze({
    [S.QUEUED]: Object.freeze([S.CLAIMED, S.CANCELLED]),
    [S.CLAIMED]: Object.freeze([S.PROVISIONING, S.QUEUED, S.FAILED, S.CANCELLING]),
    [S.PROVISIONING]: Object.freeze([S.RUNNING, S.QUEUED, S.FAILED, S.NEEDS_REVIEW, S.CANCELLING]),
    [S.RUNNING]: Object.freeze([
        S.SUCCEEDED,
        S.FAILED,
        S.TIMED_OUT,
        S.NEEDS_REVIEW,
        S.WAITING_LIMIT,
        S.QUEUED,
        S.CANCELLING,
    ]),
    [S.WAITING_LIMIT]: Object.freeze([S.QUEUED, S.CANCELLED]),
    [S.CANCELLING]: Object.freeze([S.CANCELLED]),
});

/**
 * @param {string} status
 * @returns {boolean}
 */
const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/**
 * Statuses from which `to` may be entered; used for guarded updates (WHERE status IN ...).
 * @param {string} to
 * @returns {string[]}
 */
const sourcesOf = (to) => Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));

module.exports = { JOB_STATUS, TERMINAL_STATUSES, ACTIVE_STATUSES, TRANSITIONS, isTerminal, canTransition, sourcesOf };
