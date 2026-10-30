'use strict';

const { AppUsageDaily, sequelize } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

module.exports = withErrorLogging('appUsageDaily.repository', {
    /**
     * Atomically add tokens to an app's daily total.
     * @param {string} appId
     * @param {string} day YYYY-MM-DD
     * @param {number} tokens
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    addTokens: async (appId, day, tokens, { transaction } = {}) => {
        requireAppId(appId);
        // raw because: ON CONFLICT ... DO UPDATE (atomic increment)
        await sequelize.query(
            `INSERT INTO app_usage_daily (app_id, day, tokens) VALUES (:appId, :day, :tokens)
             ON CONFLICT (app_id, day) DO UPDATE SET tokens = app_usage_daily.tokens + EXCLUDED.tokens`,
            { replacements: { appId, day, tokens }, transaction },
        );
    },

    /**
     * @param {string} appId
     * @param {string} day YYYY-MM-DD
     * @returns {Promise<number>}
     */
    getTokens: async (appId, day) => {
        requireAppId(appId);
        const row = await AppUsageDaily.findOne({ where: { appId, day }, attributes: ['tokens'], raw: true });
        return row ? Number(row.tokens) : 0;
    },
});
