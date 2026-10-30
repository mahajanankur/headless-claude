'use strict';

const { LIMIT_SCOPE, modelFamily } = require('../constants/provider');

/**
 * Weighted token count used for budgets (decision D13).
 * @param {Object|null} usage Claude usage block (input_tokens, output_tokens, cache_*_input_tokens)
 * @param {number} cacheReadWeight
 * @returns {number}
 */
const weightedTokens = (usage, cacheReadWeight) => {
    if (!usage) return 0;
    const n = (k) => Number(usage[k] || 0);
    return Math.round(
        n('input_tokens') +
            n('output_tokens') +
            n('cache_creation_input_tokens') +
            n('cache_read_input_tokens') * cacheReadWeight,
    );
};

/**
 * Normalise a rate_limit_event into stored plan utilization.
 * @param {Object} info rate_limit_event.rate_limit_info
 * @returns {{status: string, rateLimitType: string|null, resetsAt: string|null, windows: Object}}
 */
const parseRateLimitInfo = (info = {}) => {
    const toIso = (epoch) => (epoch ? new Date(Number(epoch) * 1000).toISOString() : null);
    const windows = Object.fromEntries(
        Object.entries(info.unifiedWindows || {}).map(([name, w]) => [
            name,
            { utilization: Number(w.utilization || 0), resetsAt: toIso(w.resetsAt), status: w.status || null },
        ]),
    );
    return {
        status: info.status || 'allowed',
        rateLimitType: info.rateLimitType || null,
        resetsAt: toIso(info.resetsAt),
        windows,
    };
};

/**
 * Scope that a rejected rate limit pauses: model-specific weekly windows pause only that family.
 * @param {string|null} rateLimitType e.g. 'five_hour', 'seven_day', 'seven_day_opus'
 * @returns {string}
 */
const limitScopeFor = (rateLimitType) => {
    const match = /(opus|sonnet|haiku)/i.exec(rateLimitType || '');
    return match ? LIMIT_SCOPE.model(match[1].toLowerCase()) : LIMIT_SCOPE.GLOBAL;
};

const LIMIT_TEXT = /hit your (?:(opus|sonnet|haiku) )?(session|weekly|usage)?\s*limit/i;

/**
 * Detect a plan-limit message in a result text.
 * @param {string} text
 * @returns {{scope: string}|null}
 */
const detectLimitMessage = (text) => {
    const match = LIMIT_TEXT.exec(String(text || ''));
    if (!match) return null;
    return { scope: match[1] ? LIMIT_SCOPE.model(match[1].toLowerCase()) : LIMIT_SCOPE.GLOBAL };
};

/**
 * Highest utilization across windows (0-1) and the reset of that window.
 * @param {{windows: Object}|null} usage stored plan usage
 * @returns {{utilization: number, resetsAt: string|null}}
 */
const peakUtilization = (usage) => {
    const entries = Object.values((usage && usage.windows) || {});
    if (!entries.length) return { utilization: 0, resetsAt: null };
    return entries.reduce((a, b) => (b.utilization > a.utilization ? b : a));
};

/**
 * Budget day key (YYYY-MM-DD) in the app's time zone.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
const budgetDay = (date, timeZone) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/**
 * Start of the next budget day in the app's time zone (approximate to the minute; for Retry-After).
 * @param {Date} date
 * @param {string} timeZone
 * @returns {Date}
 */
const nextBudgetReset = (date, timeZone) => {
    const today = budgetDay(date, timeZone);
    let probe = new Date(date.getTime());
    while (budgetDay(probe, timeZone) === today) probe = new Date(probe.getTime() + 15 * 60000);
    return probe;
};

module.exports = {
    weightedTokens,
    parseRateLimitInfo,
    limitScopeFor,
    detectLimitMessage,
    peakUtilization,
    budgetDay,
    nextBudgetReset,
    modelFamily,
};
