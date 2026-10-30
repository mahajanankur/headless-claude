'use strict';

const { ProviderState } = require('../db/models');

const { withErrorLogging } = require('./base.repository');

module.exports = withErrorLogging('providerState.repository', {
    /**
     * @param {string} key
     * @returns {Promise<*|null>}
     */
    get: async (key) => {
        const row = await ProviderState.findOne({ where: { key }, attributes: ['value'], raw: true });
        return row ? row.value : null;
    },

    /**
     * @param {string} key
     * @param {*} value
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    set: async (key, value, { transaction } = {}) => {
        await ProviderState.upsert({ key, value }, { transaction });
    },

    /**
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object<string, *>>} every key as a map
     */
    getAll: async ({ transaction } = {}) => {
        const rows = await ProviderState.findAll({
            attributes: ['key', 'value'],
            order: [['key', 'ASC']],
            raw: true,
            transaction,
        });
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
});
