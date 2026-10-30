'use strict';

const { Op } = require('sequelize');

const { JobEvent } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

module.exports = withErrorLogging('jobEvent.repository', {
    /**
     * Idempotent insert: (job_id, attempt_id, seq) is unique, so re-attach replays are ignored.
     * @param {Object[]} rows
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    bulkInsert: async (rows, { transaction } = {}) => {
        if (!rows.length) return;
        rows.forEach((r) => requireAppId(r.appId));
        await JobEvent.bulkCreate(rows, { ignoreDuplicates: true, transaction });
    },

    /**
     * App-scoped events after a cursor id, oldest first.
     * @param {string} jobId
     * @param {string} appId
     * @param {{afterId?: number, limit: number}} options
     * @returns {Promise<Object[]>}
     */
    listForJob: (jobId, appId, { afterId, limit }) => {
        requireAppId(appId);
        return JobEvent.findAll({
            where: { jobId, appId, id: { [Op.gt]: afterId ?? 0 } },
            attributes: ['id', 'seq', 'ts', 'type', 'summary'],
            order: [['id', 'ASC']],
            limit,
            raw: true,
        });
    },

    /**
     * Delete events older than a cutoff (retention).
     * @param {Date} cutoff
     * @returns {Promise<number>}
     */
    deleteBeforeInternal: (cutoff) => JobEvent.destroy({ where: { ts: { [Op.lt]: cutoff } } }),
});
