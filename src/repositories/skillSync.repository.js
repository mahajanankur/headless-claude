'use strict';

const { Op } = require('sequelize');

const { SkillSync } = require('../db/models');
const { SKILL_SYNC_STATUS } = require('../constants/skill');

const { withErrorLogging, requireAppId } = require('./base.repository');

const SYNC_ATTRIBUTES = [
    'id',
    'appId',
    'sourceId',
    'status',
    'result',
    'error',
    'startedAt',
    'finishedAt',
    'createdAt',
];
const ACTIVE = [SKILL_SYNC_STATUS.QUEUED, SKILL_SYNC_STATUS.RUNNING];

module.exports = withErrorLogging('skillSync.repository', {
    /**
     * @param {{appId: string, sourceId: string}} row
     * @returns {Promise<Object>}
     */
    create: async (row) => {
        requireAppId(row.appId);
        return (await SkillSync.create(row)).get({ plain: true });
    },

    /**
     * A queued or running sync of the source, if any (one at a time per source).
     * @param {string} appId
     * @param {string} sourceId
     * @returns {Promise<Object|null>}
     */
    findActive: (appId, sourceId) => {
        requireAppId(appId);
        return SkillSync.findOne({
            where: { appId, sourceId, status: ACTIVE },
            attributes: SYNC_ATTRIBUTES,
            order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        });
    },

    /**
     * @param {string} id
     * @param {string} appId
     * @param {string} sourceId
     * @returns {Promise<Object|null>}
     */
    findByIdForApp: (id, appId, sourceId) => {
        requireAppId(appId);
        return SkillSync.findOne({ where: { id, appId, sourceId }, attributes: SYNC_ATTRIBUTES, raw: true });
    },

    /**
     * Claim the oldest queued sync, or a running one whose worker stopped renewing it.
     * The claim is identified by (leaseOwner, startedAt): renew and finish only touch the row while it
     * still holds that claim, so a sync taken over by another worker is never overwritten.
     * @param {{owner: string, staleBefore: Date}} claim
     * @param {{transaction: Object}} options transaction is required (row lock)
     * @returns {Promise<Object|null>}
     */
    lockNextInternal: async ({ owner, staleBefore }, { transaction }) => {
        const row = await SkillSync.findOne({
            where: {
                [Op.or]: [
                    { status: SKILL_SYNC_STATUS.QUEUED },
                    { status: SKILL_SYNC_STATUS.RUNNING, heartbeatAt: { [Op.lt]: staleBefore } },
                ],
            },
            attributes: SYNC_ATTRIBUTES,
            order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
            ],
            lock: transaction.LOCK.UPDATE,
            skipLocked: true,
            raw: true,
            transaction,
        });
        if (!row) return null;
        const startedAt = new Date();
        await SkillSync.update(
            { status: SKILL_SYNC_STATUS.RUNNING, leaseOwner: owner, startedAt, heartbeatAt: startedAt },
            { where: { id: row.id }, transaction },
        );
        return { ...row, status: SKILL_SYNC_STATUS.RUNNING, leaseOwner: owner, startedAt };
    },

    /**
     * Worker-internal: renew the lease of a sync this worker still holds.
     * @param {{id: string, leaseOwner: string, startedAt: Date}} sync the claimed sync
     * @returns {Promise<boolean>} false when the claim was lost
     */
    renewInternal: async ({ id, leaseOwner, startedAt }) => {
        const [count] = await SkillSync.update(
            { heartbeatAt: new Date() },
            { where: { id, leaseOwner, startedAt, status: SKILL_SYNC_STATUS.RUNNING } },
        );
        return count > 0;
    },

    /**
     * Worker-internal: record the outcome, only while this worker still holds the claim.
     * @param {{id: string, leaseOwner?: string, startedAt?: Date}} sync the claimed sync
     * @param {Object} fields
     * @returns {Promise<boolean>} false when the claim was lost (the outcome was not written)
     */
    finishInternal: async ({ id, leaseOwner, startedAt }, fields) => {
        const [count] = await SkillSync.update(
            { ...fields, finishedAt: new Date() },
            { where: { id, leaseOwner, startedAt, status: SKILL_SYNC_STATUS.RUNNING } },
        );
        return count > 0;
    },

    /**
     * Retention: delete finished syncs before a date.
     * @param {Date} before
     * @returns {Promise<number>}
     */
    deleteFinishedBeforeInternal: (before) =>
        SkillSync.destroy({ where: { status: { [Op.notIn]: ACTIVE }, finishedAt: { [Op.lt]: before } } }),
});
