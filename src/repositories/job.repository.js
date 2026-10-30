'use strict';

const { Op } = require('sequelize');

const { Job, sequelize } = require('../db/models');
const { ACTIVE_STATUSES, JOB_STATUS } = require('../constants/jobStatus');

const { withErrorLogging, requireAppId } = require('./base.repository');

const JOB_ATTRIBUTES = [
    'id',
    'appId',
    'skillName',
    'skillClass',
    'model',
    'status',
    'priority',
    'urgent',
    'runAfter',
    'idempotencyKey',
    'inputHash',
    'sessionId',
    'timeoutSec',
    'attemptCount',
    'errorCode',
    'errorMessage',
    'possiblyPartial',
    'deliveryStatus',
    'deliveryError',
    'branch',
    'prUrl',
    'cancelRequested',
    'autoRetries',
    'nextAttemptMode',
    'resumeAttemptId',
    'webhookUrl',
    'createdAt',
    'startedAt',
    'finishedAt',
];

module.exports = withErrorLogging('job.repository', {
    /**
     * @param {Object} data
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>} plain job row
     */
    create: async (data, { transaction } = {}) => {
        requireAppId(data.appId);
        return (await Job.create(data, { transaction })).get({ plain: true });
    },

    /**
     * App-scoped read. Not-found and not-yours both return null (→ 404).
     * @param {string} id
     * @param {string} appId
     * @param {{withResult?: boolean}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdForApp: (id, appId, { withResult = false } = {}) => {
        requireAppId(appId);
        const attributes = withResult ? [...JOB_ATTRIBUTES, 'result'] : JOB_ATTRIBUTES;
        return Job.findOne({ where: { id, appId }, attributes, raw: true });
    },

    /**
     * @param {string} appId
     * @param {string} idempotencyKey
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdempotencyKey: (appId, idempotencyKey, { transaction } = {}) => {
        requireAppId(appId);
        return Job.findOne({ where: { appId, idempotencyKey }, attributes: JOB_ATTRIBUTES, raw: true, transaction });
    },

    /**
     * Cursor-paginated list, newest first, (created_at, id) tiebreak.
     * @param {string} appId
     * @param {{limit: number, before?: {createdAt: Date, id: string}, status?: string}} options
     * @returns {Promise<Object[]>}
     */
    listForApp: (appId, { limit, before, status }) => {
        requireAppId(appId);
        const where = { appId };
        if (status) where.status = status;
        if (before) {
            where[Op.or] = [
                { createdAt: { [Op.lt]: before.createdAt } },
                { createdAt: before.createdAt, id: { [Op.lt]: before.id } },
            ];
        }
        return Job.findAll({
            where,
            attributes: JOB_ATTRIBUTES,
            order: [
                ['createdAt', 'DESC'],
                ['id', 'DESC'],
            ],
            limit,
            raw: true,
        });
    },

    /**
     * Jobs of one session, oldest first (chat history).
     * @param {string} appId
     * @param {string} sessionId
     * @param {{limit: number}} options
     * @returns {Promise<Object[]>}
     */
    listForSession: (appId, sessionId, { limit }) => {
        requireAppId(appId);
        return Job.findAll({
            where: { appId, sessionId },
            attributes: [...JOB_ATTRIBUTES, 'input', 'result'],
            order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            limit,
            raw: true,
        });
    },

    /**
     * Stage-1 claim: lock queued jobs whose run_after has passed; other workers skip them.
     * @param {{limit: number, excludeSessionIds?: string[]}} filter
     * @param {{transaction: Object}} options transaction is required (row locks)
     * @returns {Promise<Object[]>}
     */
    lockClaimCandidatesInternal: ({ limit, excludeSessionIds = [] }, { transaction }) =>
        Job.findAll({
            where: {
                status: JOB_STATUS.QUEUED,
                [Op.and]: [
                    { [Op.or]: [{ runAfter: null }, { runAfter: { [Op.lte]: new Date() } }] },
                    excludeSessionIds.length
                        ? { [Op.or]: [{ sessionId: null }, { sessionId: { [Op.notIn]: excludeSessionIds } }] }
                        : {},
                ],
            },
            attributes: [...JOB_ATTRIBUTES, 'input', 'repoUrl', 'repoRef', 'continueFromJobId'],
            order: [
                ['priority', 'DESC'],
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            limit,
            lock: transaction.LOCK.UPDATE,
            skipLocked: true,
            raw: true,
            transaction,
        }),

    /**
     * Worker-internal read by id (full row including input).
     * @param {string} id
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id, { transaction } = {}) => Job.findOne({ where: { id }, raw: true, transaction }),

    /**
     * Guarded status update (rules §11). Returns affected row count; 0 means the guard failed.
     * @param {string} id
     * @param {string[]} fromStatuses
     * @param {Object} fields
     * @param {{transaction?: Object, appId?: string}} [options] appId scopes app-initiated updates
     * @returns {Promise<number>}
     */
    updateGuarded: async (id, fromStatuses, fields, { transaction, appId } = {}) => {
        const where = { id, status: fromStatuses };
        if (appId) where.appId = appId;
        const [count] = await Job.update(fields, { where, transaction });
        return count;
    },

    /**
     * Guarded transition that also bumps status_seq (used as the status event's sequence number).
     * @param {string} id
     * @param {string[]} fromStatuses
     * @param {Object} fields must include `status`
     * @param {{transaction?: Object, appId?: string}} [options]
     * @returns {Promise<Object|null>} the updated row, or null when the guard failed
     */
    transitionInternal: async (id, fromStatuses, fields, { transaction, appId } = {}) => {
        const where = { id, status: fromStatuses };
        if (appId) where.appId = appId;
        const [count, rows] = await Job.update(
            { ...fields, statusSeq: sequelize.literal('status_seq + 1') },
            { where, transaction, returning: true },
        );
        return count ? rows[0].get({ plain: true }) : null;
    },

    /**
     * Push a queued job's earliest start later (window/budget deferral) without a status change.
     * @param {string} id
     * @param {Date} runAfter
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    deferInternal: async (id, runAfter, { transaction } = {}) => {
        await Job.update({ runAfter }, { where: { id, status: JOB_STATUS.QUEUED }, transaction });
    },

    /**
     * Mark cancel requested on an active job (the worker acts on it).
     * @param {string} id
     * @param {string} appId
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<number>}
     */
    requestCancel: async (id, appId, { transaction } = {}) => {
        requireAppId(appId);
        const [count] = await Job.update(
            { cancelRequested: true },
            { where: { id, appId, status: ACTIVE_STATUSES }, transaction },
        );
        return count;
    },

    /**
     * Active job ids for an app (kill-switch).
     * @param {string} appId
     * @returns {Promise<string[]>}
     */
    findActiveIdsForApp: async (appId) => {
        requireAppId(appId);
        const rows = await Job.findAll({
            where: { appId, status: ACTIVE_STATUSES },
            attributes: ['id'],
            order: [['id', 'ASC']],
            raw: true,
        });
        return rows.map((r) => r.id);
    },

    /**
     * Queued/waiting job ids for an app (kill-switch).
     * @param {string} appId
     * @returns {Promise<string[]>}
     */
    findPendingIdsForApp: async (appId) => {
        requireAppId(appId);
        const rows = await Job.findAll({
            where: { appId, status: [JOB_STATUS.QUEUED, JOB_STATUS.WAITING_LIMIT] },
            attributes: ['id'],
            order: [['id', 'ASC']],
            raw: true,
        });
        return rows.map((r) => r.id);
    },

    /**
     * Jobs waiting for a plan limit whose pause has ended become queued again.
     * @param {Date} now
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<number>}
     */
    requeueWaitingLimitInternal: async (now, { transaction } = {}) => {
        const [count] = await Job.update(
            { status: JOB_STATUS.QUEUED, statusSeq: sequelize.literal('status_seq + 1') },
            { where: { status: JOB_STATUS.WAITING_LIMIT, runAfter: { [Op.lte]: now } }, transaction },
        );
        return count;
    },

    /**
     * Terminal jobs finished before a cutoff (retention), oldest first.
     * @param {Date} cutoff
     * @param {{statuses: string[], limit: number}} filter
     * @returns {Promise<Object[]>}
     */
    findFinishedBeforeInternal: (cutoff, { statuses, limit }) =>
        Job.findAll({
            where: { status: statuses, finishedAt: { [Op.lt]: cutoff } },
            attributes: ['id', 'appId', 'status', 'sessionId'],
            order: [
                ['finishedAt', 'ASC'],
                ['id', 'ASC'],
            ],
            limit,
            raw: true,
        }),

    /**
     * @param {string[]} ids
     * @returns {Promise<number>}
     */
    destroyManyInternal: (ids) => (ids.length ? Job.destroy({ where: { id: ids } }) : 0),

    /**
     * Succeeded jobs still marked with a pending delivery, finished before a cutoff.
     * @param {string} pendingStatus
     * @param {Date} olderThan
     * @returns {Promise<Object[]>}
     */
    findPendingDeliveriesInternal: (pendingStatus, olderThan) =>
        Job.findAll({
            where: { status: JOB_STATUS.SUCCEEDED, deliveryStatus: pendingStatus, finishedAt: { [Op.lt]: olderThan } },
            order: [
                ['finishedAt', 'ASC'],
                ['id', 'ASC'],
            ],
            limit: 20,
            raw: true,
        }),

    /**
     * Counts by status (health/metrics).
     * @returns {Promise<Object<string, number>>}
     */
    countByStatusInternal: async () => {
        const rows = await Job.findAll({
            attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
            group: ['status'],
            raw: true,
        });
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    },

    /**
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<{byClass: Object<string, number>, byApp: Object<string, number>, total: number}>}
     */
    countActiveInternal: async ({ transaction } = {}) => {
        const rows = await Job.findAll({
            attributes: ['appId', 'skillClass', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
            where: { status: ACTIVE_STATUSES },
            group: ['appId', 'skillClass'],
            raw: true,
            transaction,
        });
        const byClass = {};
        const byApp = {};
        let total = 0;
        rows.forEach(({ appId, skillClass, count }) => {
            const n = Number(count);
            byClass[skillClass] = (byClass[skillClass] || 0) + n;
            byApp[appId] = (byApp[appId] || 0) + n;
            total += n;
        });
        return { byClass, byApp, total };
    },

    /**
     * Active jobs leased by this host (for heartbeat, cancel checks and re-attach).
     * @param {string} hostId
     * @returns {Promise<Object[]>}
     */
    findActiveByHostInternal: (hostId) =>
        Job.findAll({
            where: { status: ACTIVE_STATUSES, leaseOwner: hostId },
            attributes: ['id', 'appId', 'status', 'cancelRequested', 'leaseExpiresAt'],
            order: [['id', 'ASC']],
            raw: true,
        }),

    /**
     * Active jobs whose lease expired (owner died).
     * @param {Date} now
     * @returns {Promise<Object[]>}
     */
    findExpiredLeasesInternal: (now) =>
        Job.findAll({
            where: { status: ACTIVE_STATUSES, leaseExpiresAt: { [Op.lt]: now } },
            attributes: ['id', 'appId', 'status', 'leaseOwner'],
            order: [['id', 'ASC']],
            raw: true,
        }),

    /**
     * @param {string[]} ids
     * @param {string} leaseOwner
     * @param {Date} leaseExpiresAt
     * @returns {Promise<number>}
     */
    renewLeasesInternal: async (ids, leaseOwner, leaseExpiresAt) => {
        if (!ids.length) return 0;
        const [count] = await Job.update(
            { leaseExpiresAt },
            { where: { id: ids, status: ACTIVE_STATUSES, leaseOwner } },
        );
        return count;
    },
});
