'use strict';

const { SkillSource } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

const SOURCE_ATTRIBUTES = [
    'id',
    'appId',
    'repoUrl',
    'ref',
    'path',
    'credentialSecret',
    'lastSyncedAt',
    'lastCommit',
    'lastError',
    'createdAt',
];

module.exports = withErrorLogging('skillSource.repository', {
    /**
     * @param {Object} row must include appId
     * @returns {Promise<Object>}
     */
    create: async (row) => {
        requireAppId(row.appId);
        return (await SkillSource.create(row)).get({ plain: true });
    },

    /**
     * @param {string} appId
     * @returns {Promise<Object[]>}
     */
    listByApp: (appId) => {
        requireAppId(appId);
        return SkillSource.findAll({
            where: { appId },
            attributes: SOURCE_ATTRIBUTES,
            order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @returns {Promise<Object|null>}
     */
    findByIdForApp: (id, appId) => {
        requireAppId(appId);
        return SkillSource.findOne({ where: { id, appId }, attributes: SOURCE_ATTRIBUTES, raw: true });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @returns {Promise<number>} rows deleted
     */
    destroy: (id, appId) => {
        requireAppId(appId);
        return SkillSource.destroy({ where: { id, appId } });
    },

    /**
     * Worker-internal read by id.
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id) => SkillSource.findOne({ where: { id }, attributes: SOURCE_ATTRIBUTES, raw: true }),

    /**
     * Worker-internal update after a sync.
     * @param {string} id
     * @param {Object} fields
     * @returns {Promise<void>}
     */
    updateInternal: async (id, fields) => {
        await SkillSource.update(fields, { where: { id } });
    },
});
