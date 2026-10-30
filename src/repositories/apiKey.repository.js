'use strict';

const { Op } = require('sequelize');

const { ApiKey } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

module.exports = withErrorLogging('apiKey.repository', {
    /**
     * @param {Object} data { appId, keyHash, displayPrefix, last4, scopes, expiresAt }
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>}
     */
    create: async (data, { transaction } = {}) => {
        requireAppId(data.appId);
        return (await ApiKey.create(data, { transaction })).get({ plain: true });
    },

    /**
     * Auth lookup: an unrevoked, unexpired key by its hash.
     * @param {string} keyHash
     * @returns {Promise<Object|null>}
     */
    findActiveByHash: (keyHash) =>
        ApiKey.findOne({
            where: {
                keyHash,
                revokedAt: null,
                [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
            },
            attributes: ['id', 'appId', 'keyHash', 'scopes', 'expiresAt'],
            raw: true,
        }),

    /**
     * @param {string} id
     * @returns {Promise<void>}
     */
    touchLastUsed: async (id) => {
        await ApiKey.update({ lastUsedAt: new Date() }, { where: { id } });
    },

    /**
     * @param {string} appId
     * @returns {Promise<Object[]>} display fields only (never the hash)
     */
    listForApp: (appId) => {
        requireAppId(appId);
        return ApiKey.findAll({
            where: { appId },
            attributes: ['id', 'displayPrefix', 'last4', 'scopes', 'expiresAt', 'revokedAt', 'lastUsedAt', 'createdAt'],
            order: [
                ['createdAt', 'DESC'],
                ['id', 'DESC'],
            ],
            raw: true,
        });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<number>}
     */
    revoke: async (id, appId, { transaction } = {}) => {
        requireAppId(appId);
        const [count] = await ApiKey.update(
            { revokedAt: new Date() },
            { where: { id, appId, revokedAt: null }, transaction },
        );
        return count;
    },
});
