'use strict';

const config = require('../../config');

const jobService = require('./job.service');
const sessionService = require('./session.service');
const jobRepository = require('../repositories/job.repository');
const { NotFoundError } = require('../utils/AppError');
const { JOB_STATUS } = require('../constants/jobStatus');
const { API_ERROR } = require('../constants/apiErrors');

const CHAT_SKILL = 'chat';
const WAIT_MAX_SEC = config.get('job.waitMaxSec');
const HISTORY_MAX = config.get('pagination.maxLimit');

const replyOf = (job) => (job.result && typeof job.result.text === 'string' ? job.result.text : null);

const resolveSession = async (context, sessionId) => {
    if (!sessionId) return sessionService.createSessionInternal(context.appId);
    const session = await sessionService.findForApp(sessionId, context.appId);
    if (!session) throw new NotFoundError('Chat not found.', API_ERROR.SESSION_NOT_FOUND);
    return { sessionId: session.id };
};

/**
 * Send one chat message. Starts a conversation when sessionId is absent; later messages continue it
 * (the same Claude session). Waits up to `waitSec` for the reply.
 * @param {Object} context req.context
 * @param {{message: string, sessionId?: string, model?: string}} body
 * @param {{waitSec?: number}} [options]
 * @returns {Promise<{sessionId: string, jobId: string, status: string, reply: string|null, error: Object|null}>}
 */
const sendMessage = async (context, { message, sessionId, model }, { waitSec = WAIT_MAX_SEC } = {}) => {
    const session = await resolveSession(context, sessionId);
    const { job } = await jobService.submitJob(
        { skill: CHAT_SKILL, input: { message }, model, sessionId: session.sessionId },
        context,
        { sessionFeatureChecked: true },
    );
    if (waitSec > 0) await jobService.waitForTerminal(job.jobId, context.appId, Math.min(waitSec, WAIT_MAX_SEC) * 1000);
    const current = await jobRepository.findByIdForApp(job.jobId, context.appId, { withResult: true });
    return {
        sessionId: session.sessionId,
        jobId: job.jobId,
        status: current.status,
        reply: current.status === JOB_STATUS.SUCCEEDED ? replyOf(current) : null,
        error: current.errorCode ? { code: current.errorCode, message: current.errorMessage } : null,
    };
};

/**
 * The conversation so far, oldest first.
 * @param {Object} context
 * @param {string} sessionId
 * @returns {Promise<{sessionId: string, messages: Object[]}>}
 * @throws {NotFoundError}
 */
const getHistory = async (context, sessionId) => {
    if (!(await sessionService.findForApp(sessionId, context.appId))) {
        throw new NotFoundError('Chat not found.', API_ERROR.SESSION_NOT_FOUND);
    }
    const jobs = await jobRepository.listForSession(context.appId, sessionId, { limit: HISTORY_MAX });
    return {
        sessionId,
        messages: jobs
            .filter((j) => j.skillName === CHAT_SKILL)
            .map((j) => ({
                jobId: j.id,
                status: j.status,
                message: j.input.message,
                reply: replyOf(j),
                createdAt: j.createdAt,
                finishedAt: j.finishedAt,
            })),
    };
};

module.exports = { sendMessage, getHistory, CHAT_SKILL };
