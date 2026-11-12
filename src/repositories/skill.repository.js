'use strict';

const { Op } = require('sequelize');

const { Skill } = require('../db/models');

const { withErrorLogging, requireAppId } = require('./base.repository');
const { SKILL_DISABLED_REASON } = require('../constants/skill');

const SKILL_ATTRIBUTES = [
    'id',
    'appId',
    'name',
    'source',
    'sourceId',
    'version',
    'manifest',
    'checksum',
    'enabled',
    'disabledReason',
    'syncedAt',
    'createdAt',
];

/** Gateway skills (built-in and shared) have no owning app. */
const GATEWAY = { appId: null };

module.exports = withErrorLogging('skill.repository', {
    /**
     * A gateway (built-in or shared) skill by name.
     * @param {string} name
     * @param {{transaction?: Object, lock?: boolean}} [options]
     * @returns {Promise<Object|null>}
     */
    findByName: (name, { transaction, lock = false } = {}) =>
        Skill.findOne({
            where: { ...GATEWAY, name },
            attributes: SKILL_ATTRIBUTES,
            raw: true,
            transaction,
            ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
        }),

    /**
     * Gateway skills by name.
     * @param {string[]} names
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object[]>}
     */
    findByNames: (names, { transaction } = {}) =>
        Skill.findAll({
            where: { ...GATEWAY, name: names },
            attributes: SKILL_ATTRIBUTES,
            order: [
                ['name', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
            transaction,
        }),

    /**
     * A skill owned by the app.
     * @param {string} appId
     * @param {string} name
     * @param {{transaction?: Object, lock?: boolean}} [options]
     * @returns {Promise<Object|null>}
     */
    findOwnedByName: (appId, name, { transaction, lock = false } = {}) => {
        requireAppId(appId);
        return Skill.findOne({
            where: { appId, name },
            attributes: SKILL_ATTRIBUTES,
            raw: true,
            transaction,
            ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
        });
    },

    /**
     * Every skill the app owns (enabled or not).
     * @param {string} appId
     * @returns {Promise<Object[]>}
     */
    listOwned: (appId) => {
        requireAppId(appId);
        return Skill.findAll({
            where: { appId },
            attributes: SKILL_ATTRIBUTES,
            order: [
                ['name', 'ASC'],
                ['id', 'ASC'],
            ],
            raw: true,
        });
    },

    /**
     * Worker-internal read by id.
     * @param {string} id
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id, { transaction } = {}) =>
        Skill.findOne({ where: { id }, attributes: SKILL_ATTRIBUTES, raw: true, transaction }),

    /**
     * @param {Object} row
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>}
     */
    create: async (row, { transaction } = {}) => (await Skill.create(row, { transaction })).get({ plain: true }),

    /**
     * Update one skill by id (service-checked ownership).
     * @param {string} id
     * @param {Object} fields
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    updateById: async (id, fields, { transaction } = {}) => {
        await Skill.update(fields, { where: { id }, transaction });
    },

    /**
     * Disable gateway skills of one source whose folder no longer exists.
     * @param {string} source
     * @param {string[]} presentNames
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    disableMissing: async (source, presentNames, { transaction } = {}) => {
        await Skill.update(
            { enabled: false, disabledReason: SKILL_DISABLED_REASON.FOLDER_REMOVED },
            {
                where: {
                    ...GATEWAY,
                    source,
                    enabled: true,
                    name: { [Op.notIn]: presentNames.length ? presentNames : [''] },
                },
                transaction,
            },
        );
    },

    /**
     * App skills deleted by their app before a date, for retention.
     * @param {Date} before
     * @param {number} limit
     * @returns {Promise<Object[]>}
     */
    findDeletedBeforeInternal: (before, limit) =>
        Skill.findAll({
            where: {
                appId: { [Op.ne]: null },
                enabled: false,
                disabledReason: SKILL_DISABLED_REASON.DELETED,
                updatedAt: { [Op.lt]: before },
            },
            attributes: ['id'],
            order: [['id', 'ASC']],
            limit,
            raw: true,
        }),

    /**
     * @param {string[]} ids
     * @returns {Promise<number>}
     */
    destroyManyInternal: (ids) => (ids.length ? Skill.destroy({ where: { id: ids } }) : 0),
});
