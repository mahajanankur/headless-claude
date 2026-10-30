'use strict';

const config = require('../../config');

const jobRepository = require('../repositories/job.repository');
const jobEventRepository = require('../repositories/jobEvent.repository');
const sessionRepository = require('../repositories/session.repository');
const { JOB_STATUS, TERMINAL_STATUSES } = require('../constants/jobStatus');

const DAY_MS = 24 * 3600e3;
const BATCH = 200;

const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

/**
 * Apply retention: old events, old jobs (rows cascade), expired sessions.
 * Returns what to delete on disk; the worker removes the files (no I/O here).
 * @returns {Promise<{events: number, jobIds: string[], failedWorkspaceJobIds: string[], sessions: Object[]}>}
 */
const applyRetention = async () => {
    const events = await jobEventRepository.deleteBeforeInternal(daysAgo(config.get('scheduler.eventsRetentionDays')));
    const oldJobs = await jobRepository.findFinishedBeforeInternal(daysAgo(config.get('scheduler.jobsRetentionDays')), {
        statuses: TERMINAL_STATUSES,
        limit: BATCH,
    });
    await jobRepository.destroyManyInternal(oldJobs.map((j) => j.id));
    const failed = await jobRepository.findFinishedBeforeInternal(
        daysAgo(config.get('scheduler.failedWorkspaceRetentionDays')),
        {
            statuses: TERMINAL_STATUSES.filter((s) => s !== JOB_STATUS.SUCCEEDED),
            limit: BATCH,
        },
    );
    const sessions = await sessionRepository.findExpiredInternal(new Date());
    await sessionRepository.destroyManyInternal(sessions.map((s) => s.id));
    return {
        events,
        jobIds: oldJobs.map((j) => j.id),
        failedWorkspaceJobIds: failed.filter((j) => !j.sessionId).map((j) => j.id),
        sessions,
    };
};

module.exports = { applyRetention };
