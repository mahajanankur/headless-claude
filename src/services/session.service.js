'use strict';

const path = require('path');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const sessionRepository = require('../repositories/session.repository');
const jobRepository = require('../repositories/job.repository');
const jobAttemptRepository = require('../repositories/jobAttempt.repository');
const { isFeatureEnabled } = require('./app.service');
const { allowsSessions } = require('./jobRequest.service');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/AppError');
const { FEATURES } = require('../constants/features');
const { API_ERROR } = require('../constants/apiErrors');
const { isTerminal } = require('../constants/jobStatus');

const DEFAULT_TTL_HOURS = config.get('sessions.defaultTtlHours');
const MAX_TTL_HOURS = config.get('sessions.maxTtlHours');

const notFound = () => new NotFoundError('Session not found.', API_ERROR.SESSION_NOT_FOUND);

const toPublicSession = (s) => ({
    sessionId: s.id,
    name: s.name,
    expiresAt: s.expiresAt,
    busy: Boolean(s.lockedByJobId),
    hasHistory: Boolean(s.claudeSessionId),
    createdAt: s.createdAt,
});

/**
 * Stable workspace for a session: every job in it shares files and the Claude transcript.
 * @param {string} appId
 * @param {string} sessionId
 * @returns {string}
 */
const sessionWorkspace = (appId, sessionId) => path.join(PATHS.appsDir, appId, 'sessions', sessionId, 'ws');

const expiry = (ttlHours) => {
    const hours = ttlHours === undefined ? DEFAULT_TTL_HOURS : ttlHours;
    if (hours < 1 || hours > MAX_TTL_HOURS)
        throw new ValidationError(`TTL (ttlHours) must be between 1 and ${MAX_TTL_HOURS}.`);
    return new Date(Date.now() + hours * 3600e3);
};

const requireSessionsFeature = (app) => {
    if (!isFeatureEnabled(app, FEATURES.SESSIONS)) throw new NotFoundError('Sessions are not enabled for this app.');
};

/**
 * @param {Object} context
 * @param {{name?: string, ttlHours?: number}} body
 * @returns {Promise<Object>}
 */
const createSession = async (context, { name, ttlHours }) => {
    requireSessionsFeature(context.app);
    if (name && (await sessionRepository.findByNameForApp(context.appId, name))) {
        throw new ConflictError(`A session named '${name}' already exists.`, 'CONFLICT');
    }
    const session = await sessionRepository.create({
        appId: context.appId,
        name: name || null,
        expiresAt: expiry(ttlHours),
    });
    await sessionRepository.updateInternal(session.id, { workspacePath: sessionWorkspace(context.appId, session.id) });
    return toPublicSession(session);
};

/**
 * @param {Object} context
 * @param {string} sessionId
 * @returns {Promise<Object>}
 */
const getSession = async (context, sessionId) => {
    requireSessionsFeature(context.app);
    const session = await sessionRepository.findByIdForApp(sessionId, context.appId);
    if (!session) throw notFound();
    return toPublicSession(session);
};

/**
 * @param {Object} context
 * @param {string} sessionId
 * @returns {Promise<void>}
 * @throws {NotFoundError|ConflictError}
 */
const deleteSession = async (context, sessionId) => {
    requireSessionsFeature(context.app);
    const session = await sessionRepository.findByIdForApp(sessionId, context.appId);
    if (!session) throw notFound();
    if (session.lockedByJobId) throw new ConflictError('Session is in use by a running job.', API_ERROR.SESSION_BUSY);
    await sessionRepository.destroyForApp(sessionId, context.appId);
};

const sessionFromJob = async (context, jobId) => {
    const source = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!source) throw new ValidationError('Job to continue from (continueFromJobId) was not found.');
    if (!isTerminal(source.status))
        throw new ValidationError('Job to continue from (continueFromJobId) has not finished.');
    if (source.sessionId) return source.sessionId;
    const attempt = await jobAttemptRepository.findLatestForJobInternal(jobId);
    if (!attempt || !attempt.claudeSessionId)
        throw new ValidationError('Job to continue from (continueFromJobId) has no session.');
    const session = await sessionRepository.create({
        appId: context.appId,
        claudeSessionId: attempt.claudeSessionId,
        workspacePath: attempt.workspacePath,
        expiresAt: expiry(),
    });
    return session.id;
};

/**
 * Session for a new job (named session or an implicit one from continueFromJobId), or null.
 * @param {{sessionId?: string, continueFromJobId?: string}} body
 * @param {Object} context
 * @param {Object} manifest
 * @param {{featureChecked?: boolean}} [options] callers that gate on their own flag (chat) skip sessionsActive
 * @returns {Promise<string|null>}
 * @throws {ValidationError|NotFoundError}
 */
const resolveForSubmit = async (body, context, manifest, { featureChecked = false } = {}) => {
    if (!body.sessionId && !body.continueFromJobId) return null;
    if (!featureChecked) requireSessionsFeature(context.app);
    if (body.sessionId && body.continueFromJobId) {
        throw new ValidationError(
            'Use either a session (sessionId) or a job to continue (continueFromJobId), not both.',
        );
    }
    if (!allowsSessions(manifest)) throw new ValidationError('This skill changes code, so it cannot run in a session.');
    if (body.continueFromJobId) return sessionFromJob(context, body.continueFromJobId);
    const session = await sessionRepository.findByIdForApp(body.sessionId, context.appId);
    if (!session || (session.expiresAt && new Date(session.expiresAt) < new Date())) throw notFound();
    return session.id;
};

/**
 * Create a session without the sessionsActive check (for chat, which is gated by chatActive).
 * @param {string} appId
 * @param {{ttlHours?: number}} [options]
 * @returns {Promise<Object>}
 */
const createSessionInternal = async (appId, { ttlHours } = {}) => {
    const session = await sessionRepository.create({ appId, expiresAt: expiry(ttlHours) });
    await sessionRepository.updateInternal(session.id, { workspacePath: sessionWorkspace(appId, session.id) });
    return toPublicSession(session);
};

/**
 * @param {string} sessionId
 * @param {string} appId
 * @returns {Promise<Object|null>}
 */
const findForApp = (sessionId, appId) => sessionRepository.findByIdForApp(sessionId, appId);

/**
 * Take the session lock inside the claim transaction.
 * @param {string} sessionId
 * @param {string} jobId
 * @param {{transaction: Object}} options
 * @returns {Promise<boolean>}
 */
const acquireLock = (sessionId, jobId, { transaction }) =>
    sessionRepository.lockInternal(sessionId, jobId, { transaction });

/**
 * @param {string} sessionId
 * @param {string} jobId
 * @param {{transaction?: Object}} [options]
 * @returns {Promise<void>}
 */
const releaseLock = (sessionId, jobId, { transaction } = {}) =>
    sessionRepository.unlockInternal(sessionId, jobId, { transaction });

/**
 * Remember the Claude session id after a session's first run.
 * @param {string} sessionId
 * @param {string} claudeSessionId
 * @param {{transaction?: Object}} [options]
 * @returns {Promise<void>}
 */
const recordClaudeSession = (sessionId, claudeSessionId, { transaction } = {}) =>
    sessionRepository.updateInternal(sessionId, { claudeSessionId }, { transaction });

/**
 * @param {string} sessionId
 * @returns {Promise<Object|null>}
 */
const getSessionInternal = (sessionId) => sessionRepository.findByIdInternal(sessionId);

/**
 * @param {{transaction?: Object}} [options]
 * @returns {Promise<string[]>}
 */
const lockedSessionIds = ({ transaction } = {}) => sessionRepository.findLockedIdsInternal({ transaction });

module.exports = {
    createSession,
    createSessionInternal,
    findForApp,
    getSession,
    deleteSession,
    resolveForSubmit,
    acquireLock,
    releaseLock,
    recordClaudeSession,
    getSessionInternal,
    lockedSessionIds,
    sessionWorkspace,
};
