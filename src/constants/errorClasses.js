'use strict';

/** Job-level failure classes stored in job_attempts.error_class (not HTTP errors). */
const ERROR_CLASS = Object.freeze({
    GATEWAY: 'gateway',
    VALIDATION: 'validation',
    DB: 'db',
    PROVIDER_AUTH: 'provider_auth',
    PROVIDER_LIMIT: 'provider_limit',
    PROVIDER_CRASH: 'provider_crash',
    SKILL_OUTPUT_INVALID: 'skill_output_invalid',
    TIMEOUT: 'timeout',
    MAX_TURNS: 'max_turns',
    OUTPUT_LIMIT: 'output_limit',
    CANCELLED: 'cancelled',
    BUDGET_EXCEEDED: 'budget_exceeded',
    DELIVERY: 'delivery',
    WEBHOOK: 'webhook',
});

module.exports = { ERROR_CLASS };
