'use strict';

const jobRepository = require('../repositories/job.repository');
const jobEventRepository = require('../repositories/jobEvent.repository');
const notifyHub = require('../infra/notifyHub');
const { NotFoundError } = require('../utils/AppError');
const { CHANNELS } = require('../constants/eventTypes');
const { isTerminal } = require('../constants/jobStatus');
const { API_ERROR } = require('../constants/apiErrors');

const PAGE = 200;

/**
 * Follow a job's events: replay from the database after `afterId`, then live via LISTEN/NOTIFY.
 * One code path for SSE and Socket.IO (rules §11 Live events).
 * @param {{jobId: string, appId: string, afterId?: number}} target
 * @param {{onEvents: (rows: Object[]) => void, onEnd: (status: string) => void}} handlers
 * @returns {Promise<() => void>} unsubscribe
 * @throws {NotFoundError} when the job is not the app's
 */
const followJob = async ({ jobId, appId, afterId = 0 }, { onEvents, onEnd }) => {
    if (!(await jobRepository.findByIdForApp(jobId, appId)))
        throw new NotFoundError('Job not found.', API_ERROR.JOB_NOT_FOUND);
    let cursor = afterId;
    let closed = false;
    let running = false;
    let again = false;
    const drain = async () => {
        for (;;) {
            const rows = await jobEventRepository.listForJob(jobId, appId, { afterId: cursor, limit: PAGE });
            if (rows.length) {
                cursor = Number(rows[rows.length - 1].id);
                if (!closed) onEvents(rows);
            }
            if (rows.length < PAGE) break;
        }
        const job = await jobRepository.findByIdForApp(jobId, appId);
        if (!closed && job && isTerminal(job.status)) {
            closed = true;
            notifyHub.removeListener(CHANNELS.JOB_EVENTS, onNotify);
            onEnd(job.status);
        }
    };
    // one drain at a time; notifications during a drain trigger exactly one more pass
    const pump = async () => {
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            do {
                again = false;
                await drain();
            } while (again && !closed);
        } catch {
            // the next notification retries
        } finally {
            running = false;
        }
    };
    const onNotify = (payload) => payload.jobId === jobId && pump();
    notifyHub.on(CHANNELS.JOB_EVENTS, onNotify);
    pump();
    return () => {
        closed = true;
        notifyHub.removeListener(CHANNELS.JOB_EVENTS, onNotify);
    };
};

module.exports = { followJob };
