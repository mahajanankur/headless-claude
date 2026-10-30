'use strict';

const { ERROR_CLASS } = require('../constants/errorClasses');
const { JOB_STATUS } = require('../constants/jobStatus');
const { ATTEMPT_MODE } = require('../constants/skill');

const ACTION = Object.freeze({ RETRY: 'retry', WAIT_LIMIT: 'wait_limit', FINISH: 'finish' });

/** Failures caused by infrastructure, not the job: retried without consuming maxAutoRetries. */
const INFRA_CLASSES = Object.freeze([ERROR_CLASS.PROVIDER_AUTH, ERROR_CLASS.GATEWAY]);

/** Deterministic failures: running again would fail the same way. */
const FINAL_CLASSES = Object.freeze([
    ERROR_CLASS.SKILL_OUTPUT_INVALID,
    ERROR_CLASS.MAX_TURNS,
    ERROR_CLASS.VALIDATION,
    ERROR_CLASS.BUDGET_EXCEEDED,
]);

/** Upper bound on total attempts when only uncounted infra failures occurred. */
const infraRetryCap = (maxAutoRetries) => maxAutoRetries * 3 + 3;

const finish = (status, extra = {}) => ({ action: ACTION.FINISH, status, ...extra });

/** Terminal status when we stop: failed only when nothing outside the workspace can have changed. */
const stopStatus = ({ errorClass, actedOutsideWorkspace }) => {
    if (actedOutsideWorkspace) return JOB_STATUS.NEEDS_REVIEW;
    return errorClass === ERROR_CLASS.TIMEOUT ? JOB_STATUS.TIMED_OUT : JOB_STATUS.FAILED;
};

/** Which mode a further attempt may use, or null when no safe retry exists (decision D18). */
const retryMode = ({ startedActing, actedOutsideWorkspace, canResume, rerunSafe }) => {
    if (!startedActing) return ATTEMPT_MODE.FRESH;
    if (canResume) return ATTEMPT_MODE.RESUME;
    if (!actedOutsideWorkspace || rerunSafe) return ATTEMPT_MODE.FRESH;
    return null;
};

/**
 * Decide what happens after a failed attempt.
 * @param {Object} input
 * @param {string} input.errorClass
 * @param {boolean} input.startedActing any mutating tool ran
 * @param {boolean} input.actedOutsideWorkspace a tool with effects beyond the workspace ran (Bash, MCP, ...)
 * @param {boolean} input.canResume the Claude session and workspace still exist
 * @param {boolean} input.rerunSafe manifest flag
 * @param {number} input.autoRetriesUsed counted retries already consumed
 * @param {number} input.maxAutoRetries
 * @param {number} [input.attemptsMade] attempts so far (bounds uncounted infra retries)
 * @param {boolean} [input.cancelRequested]
 * @returns {{action: string, status?: string, mode?: string, counted?: boolean}}
 */
const decideAfterFailure = (input) => {
    const { errorClass, startedActing, cancelRequested } = input;
    if (cancelRequested || errorClass === ERROR_CLASS.CANCELLED) {
        return finish(JOB_STATUS.CANCELLED, { possiblyPartial: startedActing });
    }
    const mode = retryMode(input);
    if (errorClass === ERROR_CLASS.PROVIDER_LIMIT) {
        return mode ? { action: ACTION.WAIT_LIMIT, mode, counted: false } : finish(JOB_STATUS.NEEDS_REVIEW);
    }
    if (FINAL_CLASSES.includes(errorClass)) return finish(stopStatus(input));
    if (INFRA_CLASSES.includes(errorClass) && !startedActing) {
        // uncounted, but bounded: a permanent misconfiguration must not retry forever
        if ((input.attemptsMade || 0) >= infraRetryCap(input.maxAutoRetries)) return finish(JOB_STATUS.FAILED);
        return { action: ACTION.RETRY, mode: ATTEMPT_MODE.FRESH, counted: false };
    }
    if (input.autoRetriesUsed >= input.maxAutoRetries || !mode) return finish(stopStatus(input));
    return { action: ACTION.RETRY, mode, counted: true };
};

module.exports = { decideAfterFailure, infraRetryCap, ACTION };
