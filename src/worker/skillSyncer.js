'use strict';

const fs = require('fs');
const path = require('path');

const { PATHS } = require('../../config/paths');

const skillService = require('../services/skill.service');
const skillSourceService = require('../services/skillSource.service');
const { listSkillFolders } = require('../services/skillFolder.service');
const { cloneRepo } = require('./git/repoManager');
const { pack } = require('../utils/skillPackage');
const getLogger = require('../utils/logger');
const { SKILL_SOURCE } = require('../constants/skill');

const logger = getLogger(__filename);

/** The folder to read skills from, refusing anything that leaves the checkout (symlinks included). */
const skillsRoot = (workTree, subPath) => {
    const base = fs.realpathSync(workTree);
    const wanted = path.resolve(base, subPath || '.');
    if (wanted !== base && !wanted.startsWith(`${base}${path.sep}`)) throw new Error('Path leaves the repository.');
    if (!fs.existsSync(wanted)) throw new Error(`Path '${subPath}' does not exist in the repository.`);
    if (fs.realpathSync(wanted) !== wanted || !fs.lstatSync(wanted).isDirectory()) {
        throw new Error(`Path '${subPath}' is not a folder in the repository.`);
    }
    return wanted;
};

/** A folder with manifest.json is one skill; otherwise each sub-folder with manifest.json is. */
const skillFoldersIn = (root) => {
    const isSkill = (dir) => fs.existsSync(path.join(dir, 'manifest.json'));
    return isSkill(root) ? [root] : listSkillFolders(root).filter(isSkill);
};

const importFolders = async (folders, source) => {
    const result = { added: [], unchanged: [], failed: [] };
    for (const dir of folders) {
        try {
            const saved = await skillService.addVersion({
                appId: source.appId,
                buffer: await pack(dir),
                source: SKILL_SOURCE.GIT,
                sourceId: source.id,
            });
            const entry = { name: saved.name, version: saved.version };
            if (saved.status === skillService.VERSION_STATUS.CREATED) result.added.push(entry);
            else result.unchanged.push(entry);
        } catch (error) {
            result.failed.push({ name: path.basename(dir), error: error.message });
        }
    }
    return result;
};

/**
 * Run one claimed sync: shallow-clone the source (hooks off, credentials only through askpass),
 * store every skill folder found as a version of the app's skill, record the outcome.
 * @param {{sync: Object, source: Object}} claimed
 * @returns {Promise<void>}
 */
const runSync = async (claimed) => {
    const { sync, source } = claimed;
    const base = path.join(PATHS.skillSyncDir, sync.id);
    const repo = { gitDir: path.join(base, 'git'), workTree: path.join(base, 'repo') };
    fs.rmSync(base, { recursive: true, force: true });
    try {
        const credential = await skillSourceService.credentialInternal(source);
        const { headSha } = await cloneRepo({ repoUrl: source.repoUrl, repoRef: source.ref, ...repo, credential });
        const folders = skillFoldersIn(skillsRoot(repo.workTree, source.path));
        if (!folders.length) throw new Error('No skill folders (with manifest.json) found.');
        const result = await importFolders(folders, source);
        await skillSourceService.finishSyncInternal(claimed, { result, commit: headSha });
        logger.info(
            `Skill sync ${sync.id}: ${result.added.length} added, ${result.unchanged.length} unchanged, ${result.failed.length} failed`,
        );
    } catch (error) {
        logger.warn(`Skill sync ${sync.id} failed: ${error.message}`);
        await skillSourceService.finishSyncInternal(claimed, { error: error.message.slice(0, 1000) });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
};

module.exports = { runSync, skillsRoot, skillFoldersIn };
