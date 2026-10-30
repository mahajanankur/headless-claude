'use strict';

const { sequelize } = require('../db/models');

const getLogger = require('./logger');

const logger = getLogger(__filename);

/**
 * Run work inside one transaction. Services only. No external I/O inside `work`.
 * Uses a Sequelize managed transaction: commit on success, rollback when work throws
 * (rules §8 pattern), without a second rollback attempt when commit itself fails.
 * @param {string} operation name used in logs
 * @param {(transaction: Object) => Promise<*>} work
 * @returns {Promise<*>} work's result, after commit
 * @throws rethrows work's (or commit's) error unchanged
 */
const withTransaction = async (operation, work) => {
    try {
        return await sequelize.transaction((transaction) => work(transaction));
    } catch (error) {
        logger.debug(`Transaction ${operation} rolled back: ${error.message}`);
        throw error;
    }
};

module.exports = { withTransaction };
