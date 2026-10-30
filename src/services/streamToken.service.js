'use strict';

const jwt = require('jsonwebtoken');

const config = require('../../config');

const { getSecrets } = require('../infra/secrets');
const { AuthError } = require('../utils/AppError');

const TTL_SEC = config.get('auth.streamTokenTtlSec');
const ISSUER = config.get('auth.streamTokenIssuer');
const SCOPE = 'job:stream';

const secret = () => {
    const value = getSecrets().streamTokenSecret;
    if (!value) throw new Error('streamTokenSecret is not configured.');
    return value;
};

/**
 * Short-lived, single-job token for browsers (decision D23).
 * @param {{jobId: string, appId: string}} subject
 * @returns {{token: string, expiresIn: number}}
 */
const issueStreamToken = ({ jobId, appId }) => ({
    token: jwt.sign({ sub: jobId, app: appId, scope: SCOPE }, secret(), {
        algorithm: 'HS256',
        expiresIn: TTL_SEC,
        issuer: ISSUER,
    }),
    expiresIn: TTL_SEC,
});

/**
 * @param {string} token
 * @returns {{jobId: string, appId: string}}
 * @throws {AuthError}
 */
const verifyStreamToken = (token) => {
    try {
        const claims = jwt.verify(token, secret(), { algorithms: ['HS256'], issuer: ISSUER });
        if (claims.scope !== SCOPE || !claims.sub || !claims.app) throw new Error('wrong scope');
        return { jobId: claims.sub, appId: claims.app };
    } catch {
        throw new AuthError('Stream token is invalid or expired.');
    }
};

module.exports = { issueStreamToken, verifyStreamToken };
