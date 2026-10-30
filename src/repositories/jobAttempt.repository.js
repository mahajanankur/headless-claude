'use strict';

const { JobAttempt } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

const PUBLIC_ATTRIBUTES = [
    'id',
    'n',
    'mode',
    'skillVersion',
    'model',
    'exitCode',
    'subtype',
    'terminalReason',
    'numTurns',
    'tokenCount',
    'usage',
    'errorClass',
    'startedAt',
    'finishedAt',
];

module.exports = withErrorLogging('jobAttempt.repository', {
    /**
     * @param {Object} data
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>}
     */
    create: async (data, { transaction } = {}) => {
        requireAppId(data.appId);
        return (await JobAttempt.create(data, { transaction })).get({ plain: true });
    },

    /**
     * @param {string} id
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id, { transaction } = {}) => JobAttempt.findOne({ where: { id }, raw: true, transaction }),

    /**
     * @param {string} jobId
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findLatestForJobInternal: (jobId, { transaction } = {}) =>
        JobAttempt.findOne({ where: { jobId }, order: [['n', 'DESC']], raw: true, transaction }),

    /**
     * Unfinished attempts for these jobs (re-attach).
     * @param {string[]} jobIds
     * @returns {Promise<Object[]>}
     */
    findOpenForJobsInternal: (jobIds) =>
        JobAttempt.findAll({ where: { jobId: jobIds, finishedAt: null }, order: [['id', 'ASC']], raw: true }),

    /**
     * App-scoped attempt history for a job.
     * @param {string} jobId
     * @param {string} appId
     * @returns {Promise<Object[]>}
     */
    listForJob: (jobId, appId) => {
        requireAppId(appId);
        return JobAttempt.findAll({
            where: { jobId, appId },
            attributes: PUBLIC_ATTRIBUTES,
            order: [['n', 'ASC']],
            raw: true,
        });
    },

    /**
     * @param {string} id
     * @param {Object} fields
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    update: async (id, fields, { transaction } = {}) => {
        await JobAttempt.update(fields, { where: { id }, transaction });
    },

    /**
     * Attempts of jobs leased by this host that have not finished (re-attach after restart).
     * @param {string} hostId
     * @returns {Promise<Object[]>}
     */
    findOpenByHostInternal: (hostId) =>
        JobAttempt.findAll({
            where: { hostId, finishedAt: null },
            order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        }),
});
