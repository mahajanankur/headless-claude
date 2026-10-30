'use strict';

const { Op } = require('sequelize');

const { Session } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');

const SESSION_ATTRIBUTES = [
    'id',
    'appId',
    'name',
    'claudeSessionId',
    'workspacePath',
    'repoUrl',
    'repoRef',
    'expiresAt',
    'lockedByJobId',
    'createdAt',
];

module.exports = withErrorLogging('session.repository', {
    /**
     * @param {Object} data
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>}
     */
    create: async (data, { transaction } = {}) => {
        requireAppId(data.appId);
        return (await Session.create(data, { transaction })).get({ plain: true });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @param {{transaction?: Object, lock?: boolean}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdForApp: (id, appId, { transaction, lock } = {}) => {
        requireAppId(appId);
        return Session.findOne({
            where: { id, appId },
            attributes: SESSION_ATTRIBUTES,
            raw: true,
            transaction,
            lock: lock && transaction ? transaction.LOCK.UPDATE : undefined,
        });
    },

    /**
     * @param {string} id
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id, { transaction } = {}) =>
        Session.findOne({ where: { id }, attributes: SESSION_ATTRIBUTES, raw: true, transaction }),

    /**
     * @param {string} appId
     * @param {string} name
     * @returns {Promise<Object|null>}
     */
    findByNameForApp: (appId, name) => {
        requireAppId(appId);
        return Session.findOne({ where: { appId, name }, attributes: SESSION_ATTRIBUTES, raw: true });
    },

    /**
     * Session ids currently held by a job (excluded from claiming).
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<string[]>}
     */
    findLockedIdsInternal: async ({ transaction } = {}) => {
        const rows = await Session.findAll({
            where: { lockedByJobId: { [Op.ne]: null } },
            attributes: ['id'],
            raw: true,
            transaction,
        });
        return rows.map((r) => r.id);
    },

    /**
     * Take the session lock for a job. Returns false when another job holds it.
     * @param {string} id
     * @param {string} jobId
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<boolean>}
     */
    lockInternal: async (id, jobId, { transaction } = {}) => {
        const [count] = await Session.update(
            { lockedByJobId: jobId },
            { where: { id, [Op.or]: [{ lockedByJobId: null }, { lockedByJobId: jobId }] }, transaction },
        );
        return count === 1;
    },

    /**
     * Release the lock if this job holds it.
     * @param {string} id
     * @param {string} jobId
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    unlockInternal: async (id, jobId, { transaction } = {}) => {
        await Session.update({ lockedByJobId: null }, { where: { id, lockedByJobId: jobId }, transaction });
    },

    /**
     * @param {string} id
     * @param {Object} fields
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    updateInternal: async (id, fields, { transaction } = {}) => {
        await Session.update(fields, { where: { id }, transaction });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @returns {Promise<number>}
     */
    destroyForApp: async (id, appId) => {
        requireAppId(appId);
        return Session.destroy({ where: { id, appId, lockedByJobId: null } });
    },

    /**
     * Expired, unlocked sessions (retention).
     * @param {Date} now
     * @returns {Promise<Object[]>}
     */
    findExpiredInternal: (now) =>
        Session.findAll({
            where: { expiresAt: { [Op.lt]: now }, lockedByJobId: null },
            attributes: SESSION_ATTRIBUTES,
            order: [['id', 'ASC']],
            raw: true,
        }),

    /**
     * @param {string[]} ids
     * @returns {Promise<void>}
     */
    destroyManyInternal: async (ids) => {
        if (ids.length) await Session.destroy({ where: { id: ids } });
    },
});
