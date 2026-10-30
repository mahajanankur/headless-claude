'use strict';

const { App } = require('../db/models');

const { withErrorLogging } = require('./base.repository');

const APP_ATTRIBUTES = [
    'id',
    'name',
    'allowedSkills',
    'allowedModels',
    'features',
    'runWindows',
    'timezone',
    'dailyTokenBudget',
    'maxConcurrent',
    'intakePaused',
    'webhookAllowedHosts',
    'streamOrigins',
    'isAdmin',
    'active',
    'gitCredentialRef',
    'webhookSecretEnc',
];

module.exports = withErrorLogging('app.repository', {
    /**
     * @param {Object} data
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>} plain app row
     */
    create: async (data, { transaction } = {}) => (await App.create(data, { transaction })).get({ plain: true }),

    /**
     * Worker/auth-internal lookup by id (an app is its own tenant).
     * @param {string} id
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id, { transaction } = {}) =>
        App.findOne({ where: { id, active: true }, attributes: APP_ATTRIBUTES, raw: true, transaction }),

    /**
     * @param {string} id
     * @param {Object} fields
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<number>}
     */
    updateInternal: async (id, fields, { transaction } = {}) => {
        const [count] = await App.update(fields, { where: { id }, transaction });
        return count;
    },

    /**
     * @param {string[]} ids
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object[]>}
     */
    findByIdsInternal: (ids, { transaction } = {}) =>
        App.findAll({ where: { id: ids }, attributes: APP_ATTRIBUTES, order: [['id', 'ASC']], raw: true, transaction }),

    /**
     * @returns {Promise<Object[]>}
     */
    findAllInternal: () =>
        App.findAll({
            attributes: APP_ATTRIBUTES,
            order: [
                ['name', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        }),
});
