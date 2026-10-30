'use strict';

const { Artifact } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

const ARTIFACT_ATTRIBUTES = ['id', 'jobId', 'name', 'size', 'mime', 'sha256', 'createdAt'];

module.exports = withErrorLogging('artifact.repository', {
    /**
     * @param {Object[]} rows
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    bulkCreate: async (rows, { transaction } = {}) => {
        if (!rows.length) return;
        rows.forEach((r) => requireAppId(r.appId));
        await Artifact.bulkCreate(rows, { transaction });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @returns {Promise<Object|null>} includes the on-disk path (never returned to clients)
     */
    findByIdForApp: (id, appId) => {
        requireAppId(appId);
        return Artifact.findOne({ where: { id, appId }, attributes: [...ARTIFACT_ATTRIBUTES, 'path'], raw: true });
    },

    /**
     * @param {string} jobId
     * @param {string} appId
     * @returns {Promise<Object[]>}
     */
    listForJob: (jobId, appId) => {
        requireAppId(appId);
        return Artifact.findAll({
            where: { jobId, appId },
            attributes: ARTIFACT_ATTRIBUTES,
            order: [
                ['name', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        });
    },
});
