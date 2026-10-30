'use strict';

const providerStateRepository = require('../repositories/providerState.repository');
const { PROVIDER_KEY } = require('../constants/provider');
const { parseRateLimitInfo, limitScopeFor } = require('./usage.service');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

const PAUSE_PREFIX = 'pause:';
const DEFAULT_PAUSE_MS = 60 * 60 * 1000;

/**
 * Everything the scheduler needs from provider state, in one read.
 * @param {{transaction?: Object}} [options]
 * @returns {Promise<{pauses: Object<string, string>, usage: Object|null, health: Object|null}>}
 */
const getSchedulingState = async ({ transaction } = {}) => {
    const all = await providerStateRepository.getAll({ transaction });
    const pauses = Object.fromEntries(
        Object.entries(all)
            .filter(([key]) => key.startsWith(PAUSE_PREFIX))
            .map(([key, value]) => [key.slice(PAUSE_PREFIX.length), value.until]),
    );
    return { pauses, usage: all[PROVIDER_KEY.USAGE] || null, health: all[PROVIDER_KEY.HEALTH] || null };
};

/**
 * Pause a scope (global or model:<family>) until a time.
 * @param {string} scope
 * @param {Date|null} until defaults to one hour from now
 * @param {string} reason
 * @returns {Promise<Date>}
 */
const pauseScope = async (scope, until, reason) => {
    const effective = until && until > new Date() ? until : new Date(Date.now() + DEFAULT_PAUSE_MS);
    await providerStateRepository.set(PROVIDER_KEY.pause(scope), { until: effective.toISOString(), reason });
    logger.warn(`Paused ${scope} until ${effective.toISOString()} (${reason})`);
    return effective;
};

/**
 * Store the latest plan utilization from a rate_limit_event; a rejected status pauses its scope.
 * @param {Object} rateLimitInfo
 * @returns {Promise<{paused: boolean, scope?: string, until?: Date}>}
 */
const recordRateLimit = async (rateLimitInfo) => {
    const usage = parseRateLimitInfo(rateLimitInfo);
    await providerStateRepository.set(PROVIDER_KEY.USAGE, { ...usage, observedAt: new Date().toISOString() });
    if (usage.status !== 'rejected') return { paused: false };
    const scope = limitScopeFor(usage.rateLimitType);
    const until = await pauseScope(
        scope,
        usage.resetsAt ? new Date(usage.resetsAt) : null,
        `rate limit ${usage.rateLimitType}`,
    );
    return { paused: true, scope, until };
};

/**
 * @param {Object} health { claudeVersion, authOk, checkedAt, ... }
 * @returns {Promise<void>}
 */
const recordHealth = (health) => providerStateRepository.set(PROVIDER_KEY.HEALTH, health);

module.exports = { getSchedulingState, pauseScope, recordRateLimit, recordHealth };
