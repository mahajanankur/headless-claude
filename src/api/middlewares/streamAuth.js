'use strict';

const appRepository = require('../../repositories/app.repository');
const appService = require('../../services/app.service');
const { verifyStreamToken } = require('../../services/streamToken.service');
const { AuthError, ForbiddenError } = require('../../utils/AppError');
const { FEATURES } = require('../../constants/features');
const { SCOPES } = require('../../constants/scopes');

/**
 * Identity for live streams: a job-scoped stream token (browsers) or an API key (backends).
 * @param {{token?: string, apiKey?: string, origin?: string, jobId?: string}} credentials
 * @returns {Promise<Object>} context { appId, app, scopes, tokenJobId? }
 * @throws {AuthError|ForbiddenError}
 */
const resolveStreamIdentity = async ({ token, apiKey, origin, jobId }) => {
    if (apiKey) {
        const identity = await appService.authenticateApiKey(apiKey);
        if (!identity.scopes.includes(SCOPES.JOBS_READ) && !identity.isAdmin)
            throw new ForbiddenError(`This API key lacks the '${SCOPES.JOBS_READ}' scope.`);
        return identity;
    }
    if (!token) throw new AuthError('A stream token or API key is required.');
    const claims = verifyStreamToken(token);
    if (jobId && claims.jobId !== jobId) throw new ForbiddenError('This stream token is for a different job.');
    const app = await appRepository.findByIdInternal(claims.appId);
    if (!app || !appService.isFeatureEnabled(app, FEATURES.STREAM_TOKENS))
        throw new AuthError('Stream token is invalid or expired.');
    if (origin && app.streamOrigins.length && !app.streamOrigins.includes(origin))
        throw new ForbiddenError('Origin is not allowed for this app.');
    return { appId: app.id, app, scopes: [SCOPES.JOBS_READ], tokenJobId: claims.jobId };
};

/** Express middleware for GET /jobs/:id/stream (EventSource cannot send headers, so ?token= is accepted). */
const streamAuth = async (req, res, next) => {
    try {
        const header = req.get('Authorization') || '';
        const identity = await resolveStreamIdentity({
            apiKey: header.startsWith('Bearer ') ? header.slice(7).trim() : null,
            token: typeof req.query.token === 'string' ? req.query.token : null,
            origin: req.get('Origin'),
            jobId: req.params.id,
        });
        req.context = { ...req.context, ...identity };
        return next();
    } catch (error) {
        return next(error);
    }
};

module.exports = { streamAuth, resolveStreamIdentity };
