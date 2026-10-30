'use strict';

const { ERROR_CLASS } = require('../constants/errorClasses');
const { detectLimitMessage } = require('./usage.service');

/** Reasons ccwrap records in exit.json when it ended the run itself. */
const WRAP_REASON = Object.freeze({
    CANCEL: 'cancel',
    TIMEOUT: 'timeout',
    OUTPUT_LIMIT: 'output_limit',
    BUDGET: 'budget',
});

const AUTH_TEXT = /not logged in|failed to authenticate|invalid (?:bearer|api) (?:token|key)|oauth token/i;

const fromWrapReason = (reason) =>
    ({
        [WRAP_REASON.CANCEL]: ERROR_CLASS.CANCELLED,
        [WRAP_REASON.TIMEOUT]: ERROR_CLASS.TIMEOUT,
        [WRAP_REASON.OUTPUT_LIMIT]: ERROR_CLASS.OUTPUT_LIMIT,
        [WRAP_REASON.BUDGET]: ERROR_CLASS.BUDGET_EXCEEDED,
    })[reason] || null;

const fromResultError = (result) => {
    const text = String(result.result || (result.errors || []).join(' '));
    if (result.subtype === 'error_max_turns') return ERROR_CLASS.MAX_TURNS;
    if (result.subtype === 'error_max_structured_output_retries') return ERROR_CLASS.SKILL_OUTPUT_INVALID;
    if (result.subtype === 'error_max_budget_usd') return ERROR_CLASS.BUDGET_EXCEEDED;
    if (detectLimitMessage(text) || result.api_error_status === 429) return ERROR_CLASS.PROVIDER_LIMIT;
    if ([401, 403].includes(result.api_error_status) || AUTH_TEXT.test(text)) return ERROR_CLASS.PROVIDER_AUTH;
    return ERROR_CLASS.PROVIDER_CRASH;
};

/**
 * Classify a finished run. Never uses the exit code (docs/claude-code-behavior.md).
 * @param {{result: Object|null, exit: Object|null, requiresStructuredOutput: boolean}} input
 *   result: the final `result` stream event; exit: ccwrap's exit.json
 * @returns {{succeeded: boolean, errorClass: string|null, message: string|null}}
 */
const classifyOutcome = ({ result, exit, requiresStructuredOutput }) => {
    const wrapClass = fromWrapReason(exit && exit.reason);
    if (wrapClass)
        return { succeeded: false, errorClass: wrapClass, message: `Run ended by the gateway (${exit.reason}).` };
    if (!result) {
        const how = exit ? `exit code ${exit.code}${exit.signal ? `, signal ${exit.signal}` : ''}` : 'no exit record';
        return {
            succeeded: false,
            errorClass: ERROR_CLASS.PROVIDER_CRASH,
            message: `Claude Code ended without a result (${how}).`,
        };
    }
    if (result.is_error || result.subtype !== 'success') {
        const message = String(result.result || (result.errors || []).join('; ') || result.terminal_reason || 'error');
        return { succeeded: false, errorClass: fromResultError(result), message: message.slice(0, 500) };
    }
    if (requiresStructuredOutput && result.structured_output === undefined) {
        return {
            succeeded: false,
            errorClass: ERROR_CLASS.SKILL_OUTPUT_INVALID,
            message: 'No structured output returned.',
        };
    }
    return { succeeded: true, errorClass: null, message: null };
};

module.exports = { classifyOutcome, WRAP_REASON };
