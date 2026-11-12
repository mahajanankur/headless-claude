'use strict';

const { AppSecret } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

module.exports = withErrorLogging('appSecret.repository', {
    /**
     * Create or replace one secret of the app.
     * @param {string} appId
     * @param {string} name
     * @param {string} valueEncrypted
     * @returns {Promise<{name: string, updatedAt: Date}>}
     */
    upsert: async (appId, name, valueEncrypted) => {
        requireAppId(appId);
        const [row] = await AppSecret.upsert(
            { appId, name, valueEncrypted, updatedAt: new Date() },
            { conflictFields: ['app_id', 'name'], returning: true },
        );
        return { name: row.get('name'), updatedAt: row.get('updatedAt') };
    },

    /**
     * Names and update times only; values are never read here.
     * @param {string} appId
     * @returns {Promise<Array<{name: string, updatedAt: Date}>>}
     */
    listNames: (appId) => {
        requireAppId(appId);
        return AppSecret.findAll({
            where: { appId },
            attributes: ['name', 'updatedAt'],
            order: [
                ['name', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        });
    },

    /**
     * @param {string} appId
     * @param {string} name
     * @returns {Promise<number>} rows deleted
     */
    destroy: (appId, name) => {
        requireAppId(appId);
        return AppSecret.destroy({ where: { appId, name } });
    },

    /**
     * Worker-internal: every encrypted secret of one app.
     * @param {string} appId
     * @returns {Promise<Array<{name: string, valueEncrypted: string}>>}
     */
    findAllInternal: (appId) => {
        requireAppId(appId);
        return AppSecret.findAll({ where: { appId }, attributes: ['name', 'valueEncrypted'], raw: true });
    },
});
