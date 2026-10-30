'use strict';

const path = require('path');

const { PATHS } = require('../../config/paths');
const skillRepository = require('../repositories/skill.repository');
const { readSkillFolder, listSkillFolders } = require('./skillFolder.service');
const { withTransaction } = require('../utils/transaction');
const { NotFoundError, ForbiddenError } = require('../utils/AppError');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

const skillNotFound = (name) => new NotFoundError(`Skill '${name}' was not found or is disabled.`, 'SKILL_NOT_FOUND');

const toDisabledRow = (result, existing) => ({
    name: result.name,
    version: existing ? existing.version : '0.0.0',
    manifest: existing ? existing.manifest : {},
    checksum: existing ? existing.checksum : 'invalid',
    enabled: false,
    disabledReason: result.error,
    syncedAt: new Date(),
});

const toEnabledRow = (result) => ({
    name: result.name,
    version: result.manifest.version,
    manifest: result.manifest,
    checksum: result.checksum,
    enabled: true,
    disabledReason: null,
    syncedAt: new Date(),
});

const toPublicSkill = (skill) => ({
    name: skill.name,
    version: skill.version,
    description: skill.manifest.description,
    class: skill.manifest.class,
    defaultModel: skill.manifest.defaultModel,
    changes: skill.manifest.changes,
    inputSchema: skill.manifest.inputSchema,
    outputSchema: skill.manifest.outputSchema || null,
});

/**
 * Validate every skill folder and register it. Invalid skills are stored disabled with the
 * reason (keeping their last good version); skills whose folder disappeared are disabled.
 * @param {string} [skillsDir]
 * @returns {Promise<Array<{name: string, enabled: boolean, error?: string}>>}
 * @throws {Error} when the directory is missing or contains no skill folders
 */
const syncFromDisk = async (skillsDir = PATHS.skillsDir) => {
    const folders = listSkillFolders(skillsDir);
    // An unmounted or mistyped skills directory must never disable every registered skill.
    if (!folders.length) throw new Error(`No skill folders found in ${skillsDir}; refusing to sync.`);
    const results = folders.map(readSkillFolder);
    const existing = await skillRepository.findByNames(results.map((r) => r.name));
    const existingByName = Object.fromEntries(existing.map((s) => [s.name, s]));
    results.filter((r) => r.error).forEach((r) => logger.warn(`Skill disabled: ${r.name} (${r.error})`));
    const rows = results.map((r) => (r.error ? toDisabledRow(r, existingByName[r.name]) : toEnabledRow(r)));
    await withTransaction('skill.syncFromDisk', async (transaction) => {
        await skillRepository.bulkUpsert(rows, { transaction });
        await skillRepository.disableMissing(
            results.map((r) => r.name),
            { transaction },
        );
    });
    return results.map((r) => ({ name: r.name, enabled: !r.error, error: r.error }));
};

/**
 * Resolve an enabled skill for execution.
 * @param {string} name
 * @returns {Promise<{name: string, version: string, checksum: string, manifest: Object, dir: string}>}
 * @throws {NotFoundError} SKILL_NOT_FOUND when missing or disabled
 */
const resolveSkill = async (name) => {
    const skill = await skillRepository.findByName(name);
    if (!skill || !skill.enabled) throw skillNotFound(name);
    return {
        name: skill.name,
        version: skill.version,
        checksum: skill.checksum,
        manifest: skill.manifest,
        dir: path.join(PATHS.skillsDir, skill.name),
    };
};

/**
 * Enabled skills the calling app may use.
 * @param {{allowedSkills: string[]}} app
 * @returns {Promise<Object[]>}
 */
const listSkillsForApp = async (app) => {
    const skills = await skillRepository.findByNames(app.allowedSkills);
    return skills.filter((s) => s.enabled).map(toPublicSkill);
};

/**
 * @param {{allowedSkills: string[]}} app
 * @param {string} name
 * @returns {Promise<Object>}
 * @throws {ForbiddenError} FORBIDDEN_SKILL when the app may not use it
 * @throws {NotFoundError} SKILL_NOT_FOUND when missing or disabled
 */
const getSkillForApp = async (app, name) => {
    if (!app.allowedSkills.includes(name)) {
        throw new ForbiddenError(`This app may not use skill '${name}'.`, 'FORBIDDEN_SKILL');
    }
    const skill = await skillRepository.findByName(name);
    if (!skill || !skill.enabled) throw skillNotFound(name);
    return toPublicSkill(skill);
};

module.exports = { syncFromDisk, resolveSkill, listSkillsForApp, getSkillForApp };
