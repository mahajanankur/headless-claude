'use strict';

const { SkillVersion } = require('../db/models');

const { withErrorLogging } = require('./base.repository');
const { compareVersions } = require('../utils/version');

/** Never read the package unless it is needed. */
const VERSION_ATTRIBUTES = ['id', 'skillId', 'version', 'checksum', 'manifest', 'sizeBytes', 'enabled', 'createdAt'];
const NEWEST_FIRST = [
    ['createdAt', 'DESC'],
    ['id', 'DESC'],
];

/**
 * Callers pass skill ids they already resolved for the app (ownership is checked in the service).
 */
module.exports = withErrorLogging('skillVersion.repository', {
    /**
     * @param {Object} row
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object>}
     */
    create: async (row, { transaction } = {}) => {
        const created = (await SkillVersion.create(row, { transaction })).get({ plain: true });
        delete created.package;
        return created;
    },

    /**
     * @param {string} skillId
     * @param {string} version
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findBySkillAndVersion: (skillId, version, { transaction } = {}) =>
        SkillVersion.findOne({ where: { skillId, version }, attributes: VERSION_ATTRIBUTES, raw: true, transaction }),

    /**
     * Highest enabled version of a skill (by version number, not upload time: a hotfix to an older
     * line must not become the latest).
     * @param {string} skillId
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findLatestEnabled: async (skillId, { transaction } = {}) => {
        const rows = await SkillVersion.findAll({
            where: { skillId, enabled: true },
            attributes: ['id', 'version'],
            raw: true,
            transaction,
        });
        if (!rows.length) return null;
        const highest = rows.reduce((best, row) => (compareVersions(row.version, best.version) > 0 ? row : best));
        return SkillVersion.findOne({
            where: { id: highest.id },
            attributes: VERSION_ATTRIBUTES,
            raw: true,
            transaction,
        });
    },

    /**
     * Every version of a skill, newest first (no packages).
     * @param {string} skillId
     * @returns {Promise<Object[]>}
     */
    listBySkill: (skillId) =>
        SkillVersion.findAll({ where: { skillId }, attributes: VERSION_ATTRIBUTES, order: NEWEST_FIRST, raw: true }),

    /**
     * Worker-internal: a version by id (no package).
     * @param {string} id
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<Object|null>}
     */
    findByIdInternal: (id, { transaction } = {}) =>
        SkillVersion.findOne({ where: { id }, attributes: VERSION_ATTRIBUTES, raw: true, transaction }),

    /**
     * Worker-internal: the package of the version with this content checksum.
     * @param {string} skillId
     * @param {string} checksum
     * @returns {Promise<Buffer|null>}
     */
    findPackageInternal: async (skillId, checksum) => {
        const row = await SkillVersion.findOne({
            where: { skillId, checksum },
            attributes: ['package'],
            order: NEWEST_FIRST,
            raw: true,
        });
        return row ? row.package : null;
    },

    /**
     * @param {string} id
     * @param {Object} fields
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    updateById: async (id, fields, { transaction } = {}) => {
        await SkillVersion.update(fields, { where: { id }, transaction });
    },
});
