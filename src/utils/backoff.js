'use strict';

/**
 * Exponential backoff with full jitter.
 * @param {number} attempt 1-based
 * @param {{baseSec: number, maxSec: number, random?: () => number}} options
 * @returns {number} delay in seconds
 */
const backoffSec = (attempt, { baseSec, maxSec, random = Math.random }) => {
    if (baseSec <= 0) return 0;
    const cap = Math.min(maxSec, baseSec * 2 ** Math.max(0, attempt - 1));
    return Math.round(cap / 2 + random() * (cap / 2));
};

module.exports = { backoffSec };
