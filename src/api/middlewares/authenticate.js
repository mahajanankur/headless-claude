'use strict';

const appService = require('../../services/app.service');
const { runWithContext } = require('../../utils/requestContext');
const { AuthError, ForbiddenError, NotFoundError } = require('../../utils/AppError');
const { SCOPES } = require('../../constants/scopes');

const bearer = (req) => {
    const header = req.get('Authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/** API key → req.context = { requestId, appId, keyId, scopes, isAdmin, app } (rules §7). */
const authenticate = async (req, res, next) => {
    try {
        const key = bearer(req);
        if (!key) throw new AuthError();
        const identity = await appService.authenticateApiKey(key);
        req.context = { ...req.context, ...identity };
        return runWithContext({ appId: identity.appId, keyId: identity.keyId }, next);
    } catch (error) {
        return next(error);
    }
};

/**
 * @param {string} scope SCOPES value
 * @returns {Function} middleware: 403 when the key lacks the scope
 */
const requireScope = (scope) => (req, res, next) =>
    req.context.scopes.includes(scope) || req.context.scopes.includes(SCOPES.ADMIN)
        ? next()
        : next(new ForbiddenError(`This API key lacks the '${scope}' scope.`));

/** 403 unless the calling app is an admin app. */
const requireAdmin = (req, res, next) =>
    req.context.isAdmin ? next() : next(new ForbiddenError('Admin access required.'));

/**
 * @param {string} feature FEATURES value
 * @returns {Function} middleware: 404 when the feature is off for the app (hides unreleased features)
 */
const requireFeature = (feature) => (req, res, next) =>
    appService.isFeatureEnabled(req.context.app, feature) ? next() : next(new NotFoundError('Not found.'));

module.exports = { authenticate, requireScope, requireAdmin, requireFeature };
