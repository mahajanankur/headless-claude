'use strict';

const { Op } = require('sequelize');

const { WebhookDelivery } = require('../db/models');
const { WEBHOOK_STATUS } = require('../constants/delivery');

const { withErrorLogging, requireAppId } = require('./base.repository');

module.exports = withErrorLogging('webhookDelivery.repository', {
    /**
     * @param {{jobId: string, appId: string}} data
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    create: async (data, { transaction } = {}) => {
        requireAppId(data.appId);
        await WebhookDelivery.create(data, { transaction });
    },

    /**
     * Lock due deliveries (other workers skip them).
     * @param {number} limit
     * @param {{transaction: Object}} options
     * @returns {Promise<Object[]>}
     */
    lockDueInternal: (limit, { transaction }) =>
        WebhookDelivery.findAll({
            where: { status: WEBHOOK_STATUS.PENDING, nextAttemptAt: { [Op.lte]: new Date() } },
            order: [
                ['nextAttemptAt', 'ASC'],
                ['id', 'ASC'],
            ],
            limit,
            lock: transaction.LOCK.UPDATE,
            skipLocked: true,
            raw: true,
            transaction,
        }),

    /**
     * @param {string} id
     * @param {Object} fields
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    updateInternal: async (id, fields, { transaction } = {}) => {
        await WebhookDelivery.update(fields, { where: { id }, transaction });
    },

    /**
     * @param {string} jobId
     * @param {string} appId
     * @returns {Promise<Object[]>}
     */
    listForJob: (jobId, appId) => {
        requireAppId(appId);
        return WebhookDelivery.findAll({
            where: { jobId, appId },
            attributes: ['id', 'status', 'attempts', 'nextAttemptAt', 'lastError', 'createdAt'],
            order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        });
    },
});
