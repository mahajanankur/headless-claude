'use strict';

const config = require('../../config');

const appRepository = require('../repositories/app.repository');
const apiKeyRepository = require('../repositories/apiKey.repository');
const { recordAudit } = require('./audit.service');
const { getSecrets } = require('../infra/secrets');
const { withTransaction } = require('../utils/transaction');
const { generateApiKey, sha256 } = require('../utils/hash');
const { encryptSecret, decryptSecret } = require('../utils/encryption');
const { AuthError, NotFoundError, ValidationError } = require('../utils/AppError');
const { DEFAULT_KEY_SCOPES, SCOPES } = require('../constants/scopes');
const { FEATURES } = require('../constants/features');
const { AUDIT_ACTION } = require('../constants/audit');

const API_KEY_PREFIX = config.get('auth.apiKeyPrefix');
const KNOWN_FEATURES = Object.values(FEATURES);

const toPublicApp = (app) => ({
    id: app.id,
    name: app.name,
    allowedSkills: app.allowedSkills,
    allowedModels: app.allowedModels,
    features: app.features,
    runWindows: app.runWindows,
    timezone: app.timezone,
    dailyTokenBudget: app.dailyTokenBudget === null ? null : Number(app.dailyTokenBudget),
    maxConcurrent: app.maxConcurrent,
    intakePaused: app.intakePaused,
    webhookAllowedHosts: app.webhookAllowedHosts,
    streamOrigins: app.streamOrigins,
    isAdmin: app.isAdmin,
});

/**
 * Resolve a raw API key to the request context. Unknown, revoked, expired keys and inactive apps → 401.
 * @param {string} rawKey
 * @returns {Promise<{appId: string, keyId: string, scopes: string[], isAdmin: boolean, app: Object}>}
 * @throws {AuthError}
 */
const authenticateApiKey = async (rawKey) => {
    if (!rawKey || !rawKey.startsWith(`${API_KEY_PREFIX}_`)) throw new AuthError();
    const key = await apiKeyRepository.findActiveByHash(sha256(rawKey));
    if (!key) throw new AuthError();
    const app = await appRepository.findByIdInternal(key.appId);
    if (!app) throw new AuthError();
    apiKeyRepository.touchLastUsed(key.id).catch(() => {});
    const scopes = app.isAdmin ? [...new Set([...key.scopes, SCOPES.ADMIN])] : key.scopes;
    return { appId: app.id, keyId: key.id, scopes, isAdmin: app.isAdmin, app };
};

const newKeyRow = (appId, { scopes = DEFAULT_KEY_SCOPES, expiresAt = null } = {}) => {
    const generated = generateApiKey(API_KEY_PREFIX);
    const row = {
        appId,
        keyHash: generated.keyHash,
        displayPrefix: generated.displayPrefix,
        last4: generated.last4,
        scopes,
        expiresAt,
    };
    return { generated, row };
};

/**
 * Create an app and its first API key. The plaintext key is returned once and never stored.
 * @param {Object} data app fields (name, allowedSkills, allowedModels, ...)
 * @param {{scopes?: string[]}} [keyOptions]
 * @returns {Promise<{app: Object, apiKey: string}>}
 */
const createApp = async (data, keyOptions = {}) =>
    withTransaction('app.create', async (transaction) => {
        const app = await appRepository.create(data, { transaction });
        const { generated, row } = newKeyRow(app.id, keyOptions);
        await apiKeyRepository.create(row, { transaction });
        await recordAudit(
            { appId: app.id, action: AUDIT_ACTION.APP_CREATED, targetType: 'app', targetId: app.id },
            { transaction },
        );
        return { app: toPublicApp(app), apiKey: generated.key };
    });

/**
 * Issue another key for an app.
 * @param {string} appId
 * @param {{scopes?: string[], expiresAt?: Date}} [options]
 * @returns {Promise<{keyId: string, apiKey: string}>}
 */
const createApiKey = async (appId, options = {}) =>
    withTransaction('app.createApiKey', async (transaction) => {
        const { generated, row } = newKeyRow(appId, options);
        const key = await apiKeyRepository.create(row, { transaction });
        await recordAudit(
            { appId, action: AUDIT_ACTION.KEY_CREATED, targetType: 'api_key', targetId: key.id },
            { transaction },
        );
        return { keyId: key.id, apiKey: generated.key };
    });

/**
 * @param {string} appId
 * @param {string} keyId
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 */
const revokeApiKey = async (appId, keyId) =>
    withTransaction('app.revokeApiKey', async (transaction) => {
        const count = await apiKeyRepository.revoke(keyId, appId, { transaction });
        if (!count) throw new NotFoundError('API key not found or already revoked.');
        await recordAudit(
            { appId, action: AUDIT_ACTION.KEY_REVOKED, targetType: 'api_key', targetId: keyId },
            { transaction },
        );
    });

/**
 * @param {string} appId
 * @returns {Promise<Object>}
 * @throws {NotFoundError}
 */
const getApp = async (appId) => {
    const app = await appRepository.findByIdInternal(appId);
    if (!app) throw new NotFoundError('App not found.');
    return toPublicApp(app);
};

/** @returns {Promise<Object[]>} */
const listApps = async () => (await appRepository.findAllInternal()).map(toPublicApp);

/**
 * Admin update of app settings. Feature flags are validated against FEATURES.
 * @param {string} appId
 * @param {Object} fields
 * @returns {Promise<Object>}
 */
const updateApp = async (appId, fields) => {
    const unknown = Object.keys(fields.features || {}).filter((f) => !KNOWN_FEATURES.includes(f));
    if (unknown.length) throw new ValidationError(`Unknown feature flags: ${unknown.join(', ')}.`);
    const changes = { ...fields };
    if (fields.webhookSecret !== undefined) {
        changes.webhookSecretEnc = fields.webhookSecret
            ? encryptSecret(fields.webhookSecret, getSecrets().encryptionKey)
            : null;
        delete changes.webhookSecret;
    }
    await withTransaction('app.update', async (transaction) => {
        const count = await appRepository.updateInternal(appId, changes, { transaction });
        if (!count) throw new NotFoundError('App not found.');
        const changed = Object.keys(fields).filter((k) => k !== 'webhookSecret');
        await recordAudit(
            { appId, action: AUDIT_ACTION.APP_UPDATED, targetType: 'app', targetId: appId, details: { changed } },
            { transaction },
        );
    });
    return getApp(appId);
};

/**
 * @param {{features?: Object}} app
 * @param {string} feature FEATURES value
 * @returns {boolean}
 */
const isFeatureEnabled = (app, feature) => Boolean(app && app.features && app.features[feature] === true);

/**
 * Decrypted webhook signing secret (worker only).
 * @param {{webhookSecretEnc?: string}} app
 * @returns {string|null}
 */
const getWebhookSecret = (app) =>
    app.webhookSecretEnc ? decryptSecret(app.webhookSecretEnc, getSecrets().encryptionKey) : null;

/**
 * @param {string} appId
 * @returns {Promise<Object[]>}
 */
const listApiKeys = (appId) => apiKeyRepository.listForApp(appId);

module.exports = {
    authenticateApiKey,
    createApp,
    createApiKey,
    revokeApiKey,
    getApp,
    listApps,
    updateApp,
    listApiKeys,
    isFeatureEnabled,
    getWebhookSecret,
    toPublicApp,
};
