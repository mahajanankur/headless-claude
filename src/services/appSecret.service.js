'use strict';

const appSecretRepository = require('../repositories/appSecret.repository');
const { recordAudit } = require('./audit.service');
const { getSecrets } = require('../infra/secrets');
const { encryptSecret, decryptSecret } = require('../utils/encryption');
const { addSecret } = require('../utils/redactor');
const { NotFoundError } = require('../utils/AppError');
const { AUDIT_ACTION } = require('../constants/audit');
const { API_ERROR } = require('../constants/apiErrors');

/**
 * Set one of the app's secrets (stored encrypted; never returned). Skills the app owns reference it
 * as "secret:<name>" in manifest env.
 * @param {{appId: string}} context
 * @param {string} name
 * @param {string} value
 * @returns {Promise<{name: string, updatedAt: Date}>}
 */
const setSecret = async ({ appId }, name, value) => {
    const saved = await appSecretRepository.upsert(appId, name, encryptSecret(value, getSecrets().encryptionKey));
    await recordAudit({ appId, action: AUDIT_ACTION.SECRET_SET, targetType: 'secret', details: { name } });
    return saved;
};

/**
 * @param {{appId: string}} context
 * @returns {Promise<Array<{name: string, updatedAt: Date}>>} names only
 */
const listSecrets = ({ appId }) => appSecretRepository.listNames(appId);

/**
 * @param {{appId: string}} context
 * @param {string} name
 * @returns {Promise<void>}
 * @throws {NotFoundError} SECRET_NOT_FOUND
 */
const deleteSecret = async ({ appId }, name) => {
    if (!(await appSecretRepository.destroy(appId, name))) {
        throw new NotFoundError(`Secret '${name}' was not found.`, API_ERROR.SECRET_NOT_FOUND);
    }
    await recordAudit({ appId, action: AUDIT_ACTION.SECRET_DELETED, targetType: 'secret', details: { name } });
};

/**
 * Worker-internal: the app's decrypted secrets, each registered with the log redactor.
 * @param {string} appId
 * @returns {Promise<Object<string, string>>}
 */
const valuesForAppInternal = async (appId) => {
    const key = getSecrets().encryptionKey;
    const rows = await appSecretRepository.findAllInternal(appId);
    return Object.fromEntries(
        rows.map(({ name, valueEncrypted }) => {
            const value = decryptSecret(valueEncrypted, key);
            addSecret(value);
            return [name, value];
        }),
    );
};

module.exports = { setSecret, listSecrets, deleteSecret, valuesForAppInternal };
