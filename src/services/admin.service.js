'use strict';

const jobRepository = require('../repositories/job.repository');
const providerStateRepository = require('../repositories/providerState.repository');
const appService = require('./app.service');
const jobService = require('./job.service');
const providerStateService = require('./providerState.service');
const { recordAudit } = require('./audit.service');
const { sequelize } = require('../db/models');
const { PROVIDER_KEY } = require('../constants/provider');
const { AUDIT_ACTION } = require('../constants/audit');

const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

/**
 * Pause or resume job intake for one app (kill-switch part 1).
 * @param {string} appId
 * @param {boolean} paused
 * @returns {Promise<Object>}
 */
const setAppIntake = async (appId, paused) => {
    const app = await appService.updateApp(appId, { intakePaused: paused });
    await recordAudit({
        appId,
        action: paused ? AUDIT_ACTION.INTAKE_PAUSED : AUDIT_ACTION.INTAKE_RESUMED,
        targetType: 'app',
        targetId: appId,
    });
    return app;
};

/**
 * Pause or resume intake for every app.
 * @param {boolean} paused
 * @returns {Promise<{paused: boolean}>}
 */
const setGlobalIntake = async (paused) => {
    const key = PROVIDER_KEY.pause('intake');
    await providerStateRepository.set(
        key,
        paused
            ? { until: FAR_FUTURE, reason: 'admin intake pause' }
            : { until: new Date(0).toISOString(), reason: 'resumed' },
    );
    await recordAudit({
        action: paused ? AUDIT_ACTION.INTAKE_PAUSED : AUDIT_ACTION.INTAKE_RESUMED,
        targetType: 'gateway',
    });
    return { paused };
};

/**
 * Kill-switch: pause the app's intake and cancel its queued and running jobs.
 * @param {string} appId
 * @param {Object} context admin request context
 * @returns {Promise<Object>}
 */
const killApp = async (appId, context) => {
    await setAppIntake(appId, true);
    return jobService.cancelAllForApp(appId, context);
};

/**
 * Operational snapshot: job counts, plan utilization, pauses, provider health.
 * @returns {Promise<Object>}
 */
const getStats = async () => {
    const [jobs, scheduling] = await Promise.all([
        jobRepository.countByStatusInternal(),
        providerStateService.getSchedulingState(),
    ]);
    const now = new Date();
    const pauses = Object.fromEntries(Object.entries(scheduling.pauses).filter(([, until]) => new Date(until) > now));
    return { jobs, usage: scheduling.usage, pauses, health: scheduling.health };
};

const isDatabaseUp = async () => {
    try {
        // raw because: connectivity probe
        await sequelize.query('SELECT 1');
        return true;
    } catch {
        return false;
    }
};

/**
 * Readiness: database reachable and the latest provider health.
 * @returns {Promise<{ready: boolean, database: boolean, provider: Object|null}>}
 */
const getReadiness = async () => {
    const database = await isDatabaseUp();
    const provider = database ? (await providerStateService.getSchedulingState()).health : null;
    return { ready: database, database, provider };
};

module.exports = { setAppIntake, setGlobalIntake, killApp, getStats, getReadiness };
