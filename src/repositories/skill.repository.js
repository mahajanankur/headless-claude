'use strict';

const { Op } = require('sequelize');

const { Skill } = require('../db/models');

const { withErrorLogging } = require('./base.repository');

const SKILL_ATTRIBUTES = ['id', 'name', 'version', 'manifest', 'checksum', 'enabled', 'disabledReason', 'syncedAt'];

module.exports = withErrorLogging('skill.repository', {
    /**
     * Insert or update many skills in one statement, keyed by the unique name.
     * @param {Object[]} rows
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    bulkUpsert: async (rows, { transaction } = {}) => {
        if (!rows.length) return;
        await Skill.bulkCreate(rows, {
            conflictAttributes: ['name'],
            updateOnDuplicate: [
                'version',
                'manifest',
                'checksum',
                'enabled',
                'disabledReason',
                'syncedAt',
                'updatedAt',
            ],
            transaction,
        });
    },

    /**
     * @param {string} name
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByName: (name, { transaction } = {}) =>
        Skill.findOne({ where: { name }, attributes: SKILL_ATTRIBUTES, raw: true, transaction }),

    /**
     * @param {string[]} names
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object[]>}
     */
    findByNames: (names, { transaction } = {}) =>
        Skill.findAll({
            where: { name: names },
            attributes: SKILL_ATTRIBUTES,
            order: [['name', 'ASC']],
            raw: true,
            transaction,
        }),

    /**
     * Disable skills whose folder no longer exists.
     * @param {string[]} presentNames
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    disableMissing: async (presentNames, { transaction } = {}) => {
        await Skill.update(
            { enabled: false, disabledReason: 'skill folder removed' },
            { where: { enabled: true, name: { [Op.notIn]: presentNames.length ? presentNames : [''] } }, transaction },
        );
    },
});
