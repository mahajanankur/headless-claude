'use strict';

const { SKILL_CLASS } = require('../constants/skill');
const { LIMIT_SCOPE, modelFamily } = require('../constants/provider');
const { isAllowedByWindows, nextAllowedTime } = require('../utils/timeWindow');
const { peakUtilization, nextBudgetReset } = require('./usage.service');

const BLOCK = Object.freeze({
    NO_SLOT: 'no_slot',
    NO_LONG_SLOT: 'no_long_slot',
    APP_CONCURRENCY: 'app_concurrency',
    PAUSED: 'paused',
    USAGE: 'usage_threshold',
    BUDGET: 'budget',
    WINDOW: 'window',
    INTAKE: 'intake_paused',
});

const allow = () => ({ ok: true });
const block = (reason, retryAt = null) => ({ ok: false, reason, retryAt });

const activePause = (pauses, scope, now) => {
    const until = pauses[scope];
    return until && new Date(until) > now ? new Date(until) : null;
};

const slotBlock = ({ job, app, active, limits }) => {
    if (active.total >= limits.concurrency) return block(BLOCK.NO_SLOT);
    if (job.skillClass === SKILL_CLASS.LONG && (active.byClass[SKILL_CLASS.LONG] || 0) >= limits.longSlots) {
        return block(BLOCK.NO_LONG_SLOT);
    }
    if ((active.byApp[app.id] || 0) >= app.maxConcurrent) return block(BLOCK.APP_CONCURRENCY);
    return null;
};

const providerBlock = ({ job, pauses, usage, thresholds, now }) => {
    const pausedUntil =
        activePause(pauses, LIMIT_SCOPE.GLOBAL, now) ||
        activePause(pauses, LIMIT_SCOPE.model(modelFamily(job.model)), now);
    if (pausedUntil) return block(BLOCK.PAUSED, pausedUntil);
    const peak = peakUtilization(usage);
    const threshold = job.skillClass === SKILL_CLASS.LONG ? thresholds.long : thresholds.quick;
    if (peak.utilization >= threshold) return block(BLOCK.USAGE, peak.resetsAt ? new Date(peak.resetsAt) : null);
    return null;
};

const appBlock = ({ job, app, manifest, budget, now }) => {
    if (app.intakePaused) return block(BLOCK.INTAKE);
    if (app.dailyTokenBudget && budget.used >= Number(app.dailyTokenBudget)) {
        return block(BLOCK.BUDGET, nextBudgetReset(now, app.timezone));
    }
    if (!job.urgent && !(isAllowedByWindows(now, app.runWindows) && isAllowedByWindows(now, manifest.runWindows))) {
        return block(BLOCK.WINDOW, nextAllowedTime(now, app.runWindows, manifest.runWindows));
    }
    return null;
};

/**
 * May this job start now? Pure (decision D10). `urgent` skips only the run window.
 * @param {Object} ctx
 * @param {Object} ctx.job {skillClass, model, urgent}
 * @param {Object} ctx.app {id, maxConcurrent, dailyTokenBudget, timezone, runWindows, intakePaused}
 * @param {Object} ctx.manifest {runWindows}
 * @param {{total: number, byClass: Object, byApp: Object}} ctx.active
 * @param {{concurrency: number, longSlots: number}} ctx.limits
 * @param {Object<string, string>} ctx.pauses scope → ISO until
 * @param {Object|null} ctx.usage stored plan utilization
 * @param {{quick: number, long: number}} ctx.thresholds
 * @param {{used: number}} ctx.budget
 * @param {Date} ctx.now
 * @returns {{ok: boolean, reason?: string, retryAt?: Date|null}}
 */
const canStart = (ctx) => slotBlock(ctx) || providerBlock(ctx) || appBlock(ctx) || allow();

/** Blocks that are about this job alone and won't clear before retryAt; the claimer defers the job. */
const DEFERRABLE = Object.freeze([BLOCK.WINDOW, BLOCK.BUDGET]);

module.exports = { canStart, BLOCK, DEFERRABLE };
