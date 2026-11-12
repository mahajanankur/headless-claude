'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const skillRepository = require('../repositories/skill.repository');
const skillVersionRepository = require('../repositories/skillVersion.repository');
const { readSkillFolder, listSkillFolders, toolFamily } = require('./skillFolder.service');
const { recordAudit } = require('./audit.service');
const { isFeatureEnabled, getApp } = require('./app.service');
const { withTransaction } = require('../utils/transaction');
const { pack, unpack, PackageError } = require('../utils/skillPackage');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError, PG_ERROR } = require('../utils/AppError');
const getLogger = require('../utils/logger');
const {
    SKILL_SOURCE,
    SKILL_OWNER,
    SKILL_DISABLED_REASON,
    CREDENTIAL_PROFILE,
    SHELL_TOOLS,
    BARE_FILE_TOOLS,
    SKILL_NAME_PATTERN,
} = require('../constants/skill');
const { FEATURES } = require('../constants/features');
const { API_ERROR } = require('../constants/apiErrors');
const { AUDIT_ACTION } = require('../constants/audit');

const logger = getLogger(__filename);

const LIMITS = Object.freeze({
    maxPackageBytes: config.get('skills.maxPackageBytes'),
    maxUnpackedBytes: config.get('skills.maxUnpackedBytes'),
    maxFiles: config.get('skills.maxFiles'),
});
const SKILL_NAME = SKILL_NAME_PATTERN;
const DISABLED = SKILL_DISABLED_REASON;
const VERSION_STATUS = Object.freeze({ CREATED: 'created', UNCHANGED: 'unchanged' });

/** Whether the app's own skills count: with skillsManageActive off it behaves exactly as before them. */
const usesOwnSkills = (app) => Boolean(app && app.id) && isFeatureEnabled(app, FEATURES.SKILLS_MANAGE);

const skillNotFound = (name) =>
    new NotFoundError(`Skill '${name}' was not found or is disabled.`, API_ERROR.SKILL_NOT_FOUND);

const ownerOf = (skill) => {
    if (skill.appId) return SKILL_OWNER.APP;
    return skill.source === SKILL_SOURCE.SHARED ? SKILL_OWNER.SHARED : SKILL_OWNER.BUILTIN;
};

const toPublicSkill = (skill) => ({
    name: skill.name,
    version: skill.version,
    description: skill.manifest.description,
    class: skill.manifest.class,
    defaultModel: skill.manifest.defaultModel,
    changes: skill.manifest.changes,
    inputSchema: skill.manifest.inputSchema,
    outputSchema: skill.manifest.outputSchema || null,
    owner: ownerOf(skill),
});

const toPublicVersion = (v) => ({
    version: v.version,
    checksum: v.checksum,
    sizeBytes: v.sizeBytes,
    enabled: v.enabled,
    createdAt: v.createdAt,
});

const latestFields = (version) => ({
    version: version.version || version.manifest.version,
    manifest: version.manifest,
    checksum: version.checksum,
    syncedAt: new Date(),
});

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

const readPackageName = (dir) => {
    try {
        const { name } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        return typeof name === 'string' && SKILL_NAME.test(name) ? name : null;
    } catch {
        return null;
    }
};

/**
 * Unpack and validate a package with the same rules as a skill folder (readSkillFolder).
 * @param {Buffer} buffer gzipped tar
 * @returns {Promise<{name: string, manifest: Object, checksum: string}>}
 * @throws {ValidationError} SKILL_PACKAGE_REJECTED or SKILL_INVALID
 */
const inspectPackage = async (buffer) => {
    if (!buffer || !buffer.length) {
        throw new ValidationError('Package body is empty.', undefined, API_ERROR.SKILL_PACKAGE_REJECTED);
    }
    if (buffer.length > LIMITS.maxPackageBytes) {
        throw new ValidationError(
            `Package is larger than ${LIMITS.maxPackageBytes} bytes.`,
            undefined,
            API_ERROR.SKILL_PACKAGE_REJECTED,
        );
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-skill-'));
    try {
        const unpacked = path.join(tmp, 'package');
        await unpack(buffer, unpacked, LIMITS);
        const name = readPackageName(unpacked);
        if (!name) {
            throw new ValidationError(
                'manifest.json is missing or has no valid name (lowercase letters, digits and dashes).',
                undefined,
                API_ERROR.SKILL_INVALID,
            );
        }
        const dir = path.join(tmp, name);
        fs.renameSync(unpacked, dir);
        const result = await readSkillFolder(dir);
        if (result.error)
            throw new ValidationError(`Skill invalid: ${result.error}.`, undefined, API_ERROR.SKILL_INVALID);
        return { name, manifest: result.manifest, checksum: result.checksum };
    } catch (error) {
        if (error instanceof PackageError) {
            throw new ValidationError(error.message, undefined, API_ERROR.SKILL_PACKAGE_REJECTED);
        }
        throw error;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};

// ---------------------------------------------------------------------------------------------
// Gateway skills (built-in and shared folders)
// ---------------------------------------------------------------------------------------------

const toDisabledFields = (error) => ({ enabled: false, disabledReason: error, syncedAt: new Date() });

/** Store one valid folder skill as a version; editing a folder without bumping its version replaces that version. */
const storeFolderVersion = async (skill, folder, buffer, transaction) => {
    const existing = await skillVersionRepository.findBySkillAndVersion(skill.id, folder.manifest.version, {
        transaction,
    });
    const fields = {
        checksum: folder.checksum,
        manifest: folder.manifest,
        package: buffer,
        sizeBytes: buffer.length,
        enabled: true,
    };
    if (!existing) {
        await skillVersionRepository.create(
            { skillId: skill.id, version: folder.manifest.version, ...fields },
            { transaction },
        );
    } else if (existing.checksum !== folder.checksum) {
        logger.warn(`Skill ${skill.name}@${folder.manifest.version} changed without a version bump; replacing it.`);
        await skillVersionRepository.updateById(existing.id, fields, { transaction });
    }
    await skillRepository.updateById(
        skill.id,
        { ...latestFields({ version: folder.manifest.version, ...folder }), enabled: true, disabledReason: null },
        { transaction },
    );
};

const syncFolder = async (folder, buffer, source, transaction) => {
    let owned = await skillRepository.findByName(folder.name, { transaction, lock: true });
    if (owned && owned.source !== source) {
        // a skill whose folder was removed from the other gateway source moves here (e.g. built-in → shared)
        if (owned.disabledReason !== DISABLED.FOLDER_REMOVED) {
            return { name: folder.name, error: `name already used by a ${owned.source} skill` };
        }
        await skillRepository.updateById(owned.id, { source }, { transaction });
        owned = { ...owned, source };
    }
    if (folder.error) {
        if (owned) await skillRepository.updateById(owned.id, toDisabledFields(folder.error), { transaction });
        else {
            await skillRepository.create(
                {
                    name: folder.name,
                    source,
                    version: '0.0.0',
                    manifest: {},
                    checksum: 'invalid',
                    ...toDisabledFields(folder.error),
                },
                { transaction },
            );
        }
        return { name: folder.name, error: folder.error };
    }
    const skill =
        owned ||
        (await skillRepository.create(
            { name: folder.name, source, ...latestFields({ version: folder.manifest.version, ...folder }) },
            { transaction },
        ));
    await storeFolderVersion(skill, folder, buffer, transaction);
    return { name: folder.name };
};

/**
 * Validate every skill folder in a gateway folder (built-in or shared) and store each as a version.
 * Invalid skills are stored disabled with the reason (keeping their last good version); skills of the
 * same source whose folder disappeared are disabled.
 * @param {string} [skillsDir]
 * @param {string} [source] SKILL_SOURCE.BUILTIN or SKILL_SOURCE.SHARED
 * @returns {Promise<Array<{name: string, enabled: boolean, error?: string}>>}
 * @throws {Error} when the directory is missing or contains no skill folders
 */
const syncFromDisk = async (skillsDir = PATHS.skillsDir, source = SKILL_SOURCE.BUILTIN) => {
    const folders = listSkillFolders(skillsDir);
    // An unmounted or mistyped skills directory must never disable every registered skill.
    if (!folders.length) throw new Error(`No skill folders found in ${skillsDir}; refusing to sync.`);
    const read = await Promise.all(folders.map(async (dir) => ({ dir, ...(await readSkillFolder(dir)) })));
    // packing reads files: done before the transaction (rules N4)
    const buffers = await Promise.all(read.map((f) => (f.error ? null : pack(f.dir))));
    const results = await withTransaction('skill.syncFromDisk', async (transaction) => {
        const out = [];
        for (const [i, folder] of read.entries()) {
            out.push(await syncFolder(folder, buffers[i], source, transaction));
        }
        await skillRepository.disableMissing(
            source,
            read.map((f) => f.name),
            { transaction },
        );
        return out;
    });
    results.filter((r) => r.error).forEach((r) => logger.warn(`Skill disabled: ${r.name} (${r.error})`));
    return results.map((r) => ({ name: r.name, enabled: !r.error, error: r.error }));
};

/**
 * Re-read the built-in folder and, when configured, the shared folder.
 * @returns {Promise<Array<{name: string, enabled: boolean, error?: string, source: string}>>}
 */
const syncGatewaySkills = async () => {
    const builtin = (await syncFromDisk(PATHS.skillsDir, SKILL_SOURCE.BUILTIN)).map((r) => ({
        ...r,
        source: SKILL_SOURCE.BUILTIN,
    }));
    if (!PATHS.sharedSkillsDir) return builtin;
    const shared = (await syncFromDisk(PATHS.sharedSkillsDir, SKILL_SOURCE.SHARED)).map((r) => ({
        ...r,
        source: SKILL_SOURCE.SHARED,
    }));
    return [...builtin, ...shared];
};

/**
 * Admin: re-read the built-in and shared folders now (audited).
 * @returns {Promise<Array<{name: string, enabled: boolean, error?: string, source: string}>>}
 */
const resyncGatewaySkills = async () => {
    const results = await syncGatewaySkills();
    await recordAudit({
        action: AUDIT_ACTION.SKILLS_RESYNCED,
        targetType: 'skills',
        details: { synced: results.length, disabled: results.filter((r) => !r.enabled).length },
    });
    return results;
};

// ---------------------------------------------------------------------------------------------
// App skills
// ---------------------------------------------------------------------------------------------

// the built-in folder ships with the package and never changes while the process runs: read it once
let builtinNames = null;

/** Whether the package ships a built-in skill with this name (read before any transaction: rules N4). */
const isBuiltinFolderName = (name) => {
    if (!builtinNames) builtinNames = new Set(listSkillFolders(PATHS.skillsDir).map((dir) => path.basename(dir)));
    return builtinNames.has(name);
};

const assertNameFree = async ({ name, isBuiltinName }, transaction) => {
    // names the package ships as built-in always belong to the gateway; any other gateway skill frees its name
    // only once its folder is removed, so a skill that is broken for a moment can't be taken over
    const gateway = await skillRepository.findByName(name, { transaction });
    const reserved = isBuiltinName || (gateway && gateway.disabledReason !== DISABLED.FOLDER_REMOVED);
    if (reserved) {
        throw new ConflictError(
            `The name '${name}' is used by a gateway skill; choose another name.`,
            API_ERROR.SKILL_NAME_TAKEN,
        );
    }
};

/**
 * Rules an app's own skill follows on top of the folder validator.
 * @param {Object} manifest
 * @param {Object} app
 * @returns {string|null} the problem, or null when the skill may run for this app
 */
const appSkillProblem = (manifest, app) => {
    // D14: app skills always run on the default credential, never the gateway's API key
    if (manifest.credentialProfile !== CREDENTIAL_PROFILE.MAX_SUBSCRIPTION) {
        return `App skills cannot set credentialProfile '${manifest.credentialProfile}'`;
    }
    // workspace and skill files need no allow rule; a path rule could reach the credential (/proc) or the host
    const pathRules = (manifest.allowedTools || []).filter(
        (tool) => BARE_FILE_TOOLS.includes(toolFamily(tool)) && tool !== toolFamily(tool),
    );
    if (pathRules.length) return `allowedTools must not contain file path rules (${pathRules.join(', ')})`;
    // code run in the sandbox can read the Claude credential: only an admin can allow it per app (D50)
    if (isFeatureEnabled(app, FEATURES.SKILLS_SHELL)) return null;
    const shell = (manifest.allowedTools || []).filter((tool) => SHELL_TOOLS.includes(toolFamily(tool)));
    if (shell.length) {
        return `allowedTools must not contain ${shell.join(', ')} unless an admin turns on ${FEATURES.SKILLS_SHELL} for the app`;
    }
    if (Object.keys(manifest.mcpServers || {}).length) {
        return `mcpServers are not allowed unless an admin turns on ${FEATURES.SKILLS_SHELL} for the app`;
    }
    return null;
};

/**
 * Why a skill can't run for this app now, or null. Gateway skills always pass; an app's own skill needs
 * skillsManageActive and must follow the app skill rules (the flags may have changed since upload).
 * @param {{appId?: string|null, name: string, manifest: Object}} skill
 * @param {Object} app
 * @returns {string|null}
 */
const appSkillBlockReason = (skill, app) => {
    if (!skill.appId) return null;
    if (!usesOwnSkills(app))
        return `Skill '${skill.name}' is not available: ${FEATURES.SKILLS_MANAGE} is off for this app.`;
    const problem = appSkillProblem(skill.manifest, app);
    return problem ? `Skill '${skill.name}' is blocked: ${problem}.` : null;
};

/** A deleted skill gives up its name (renamed out of the way), so uploading the name again starts afresh. */
const tombstoneName = (skill) => `${skill.name}~deleted~${skill.id.replace(/-/g, '').slice(0, 12)}`;

const markDeleted = (skill, transaction) =>
    skillRepository.updateById(
        skill.id,
        { enabled: false, disabledReason: DISABLED.DELETED, name: tombstoneName(skill) },
        { transaction },
    );

const insertVersion = async ({ skill, pkg, buffer, keyId }, transaction) => {
    const existing = await skillVersionRepository.findBySkillAndVersion(skill.id, pkg.manifest.version, {
        transaction,
    });
    if (existing && existing.checksum === pkg.checksum) return VERSION_STATUS.UNCHANGED;
    if (existing) {
        throw new ConflictError(
            `Version ${pkg.manifest.version} of '${pkg.name}' already exists with different content; bump the version.`,
            API_ERROR.SKILL_VERSION_EXISTS,
        );
    }
    await skillVersionRepository.create(
        {
            skillId: skill.id,
            version: pkg.manifest.version,
            checksum: pkg.checksum,
            manifest: pkg.manifest,
            package: buffer,
            sizeBytes: buffer.length,
            createdByKeyId: keyId || null,
        },
        { transaction },
    );
    return VERSION_STATUS.CREATED;
};

const findLiveOwned = async (appId, name, transaction) => {
    const found = await skillRepository.findOwnedByName(appId, name, { transaction, lock: true });
    if (!found || found.disabledReason !== DISABLED.DELETED) return found;
    await markDeleted(found, transaction); // deleted before deletes renamed the row
    return null;
};

const saveAppVersion = ({ appId, source, sourceId, pkg, buffer, keyId, isBuiltinName }) =>
    withTransaction('skill.addVersion', async (transaction) => {
        await assertNameFree({ name: pkg.name, isBuiltinName }, transaction);
        const existing = await findLiveOwned(appId, pkg.name, transaction);
        const skill =
            existing ||
            (await skillRepository.create(
                { appId, name: pkg.name, source, sourceId: sourceId || null, ...latestFields(pkg) },
                { transaction },
            ));
        const status = await insertVersion({ skill, pkg, buffer, keyId }, transaction);
        if (status !== VERSION_STATUS.CREATED) return status;
        if (existing) {
            // the highest enabled version becomes the latest (an older hotfix does not); a skill the app turned
            // off stays off, and one that had no enabled version comes back (refreshLatest)
            await skillRepository.updateById(skill.id, { source, sourceId: sourceId || null }, { transaction });
            await refreshLatest(existing, transaction);
        }
        await recordAudit(
            {
                appId,
                action: AUDIT_ACTION.SKILL_VERSION_ADDED,
                targetType: 'skill',
                targetId: skill.id,
                details: { name: pkg.name, version: pkg.manifest.version, source },
            },
            { transaction },
        );
        return status;
    });

/**
 * Validate and store a new version of an app-owned skill (spec §4).
 * Same version and content is a no-op; same version with different content is refused.
 * @param {{appId: string, buffer: Buffer, source?: string, sourceId?: string, keyId?: string}} input
 * @returns {Promise<{name: string, version: string, checksum: string, status: string}>}
 * @throws {ValidationError|ConflictError}
 */
const addVersion = async ({ appId, buffer, source = SKILL_SOURCE.UPLOAD, sourceId = null, keyId = null }) => {
    if (!appId) throw new Error('appId is required');
    const pkg = await inspectPackage(buffer);
    const problem = appSkillProblem(pkg.manifest, await getApp(appId));
    if (problem) throw new ValidationError(`${problem}.`, undefined, API_ERROR.SKILL_INVALID);
    const isBuiltinName = isBuiltinFolderName(pkg.name);
    let status;
    try {
        status = await saveAppVersion({ appId, source, sourceId, pkg, buffer, keyId, isBuiltinName });
    } catch (error) {
        const pgCode = (error.parent || error.original || {}).code;
        if (pgCode === PG_ERROR.UNIQUE) {
            throw new ConflictError('The skill was changed at the same time; retry.', API_ERROR.SKILL_VERSION_EXISTS);
        }
        throw error;
    }
    return { name: pkg.name, version: pkg.manifest.version, checksum: pkg.checksum, status };
};

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

const pickVersion = async (skill, version) => {
    if (!version) return { id: null, version: skill.version, checksum: skill.checksum, manifest: skill.manifest };
    const row = await skillVersionRepository.findBySkillAndVersion(skill.id, version);
    if (!row || !row.enabled) {
        throw new NotFoundError(
            `Version ${version} of skill '${skill.name}' was not found or is disabled.`,
            API_ERROR.SKILL_NOT_FOUND,
        );
    }
    return row;
};

/**
 * Resolve the skill a job runs: the app's own skill first, then a built-in or shared skill the app is
 * granted (allowedSkills). The latest enabled version unless one is pinned.
 * @param {{id: string, allowedSkills: string[]}} app
 * @param {string} name
 * @param {string} [version]
 * @returns {Promise<{skillId: string, versionId: string|null, name: string, version: string, checksum: string, manifest: Object}>}
 * @throws {ForbiddenError} FORBIDDEN_SKILL; {NotFoundError} SKILL_NOT_FOUND
 */
const resolveForJob = async (app, name, version = null) => {
    let skill = usesOwnSkills(app) ? await skillRepository.findOwnedByName(app.id, name) : null;
    if (!skill) {
        if (!app.allowedSkills.includes(name)) {
            throw new ForbiddenError(`This app may not use skill '${name}'.`, API_ERROR.FORBIDDEN_SKILL);
        }
        skill = await skillRepository.findByName(name);
    }
    if (!skill || !skill.enabled) throw skillNotFound(name);
    const picked = await pickVersion(skill, version);
    return {
        skillId: skill.id,
        versionId: picked.id,
        name: skill.name,
        version: picked.version,
        checksum: picked.checksum,
        manifest: picked.manifest,
    };
};

/**
 * Resolve an enabled gateway skill by name (operations and tests).
 * @param {string} name
 * @returns {Promise<{name: string, version: string, checksum: string, manifest: Object}>}
 * @throws {NotFoundError} SKILL_NOT_FOUND when missing or disabled
 */
const resolveSkill = async (name) => {
    const skill = await skillRepository.findByName(name);
    if (!skill || !skill.enabled) throw skillNotFound(name);
    return { name: skill.name, version: skill.version, checksum: skill.checksum, manifest: skill.manifest };
};

/**
 * Worker: the skill version a queued job would run now (claim-time check).
 * @param {{skillId?: string, skillVersionId?: string, skillName: string}} job
 * @param {{transaction?: Object}} [options]
 * @returns {Promise<{id: string, appId: string|null, name: string, version: string, checksum: string, manifest: Object}|null>}
 *   null when the skill or pinned version is gone or disabled
 */
const resolveForClaimInternal = async (job, { transaction } = {}) => {
    const skill = job.skillId
        ? await skillRepository.findByIdInternal(job.skillId, { transaction })
        : await skillRepository.findByName(job.skillName, { transaction });
    if (!skill || !skill.enabled) return null;
    if (!job.skillVersionId) return skill;
    const version = await skillVersionRepository.findByIdInternal(job.skillVersionId, { transaction });
    if (!version || !version.enabled) return null;
    return { ...skill, version: version.version, checksum: version.checksum, manifest: version.manifest };
};

const resolveUse = async (app, ownerAppId, name) => {
    // a gateway skill's dependencies are gateway skills (set by the admin); an app skill's are its app's own
    // skills, then gateway skills the app is granted (allowedSkills), never any other
    const own = ownerAppId && usesOwnSkills(app) ? await skillRepository.findOwnedByName(app.id, name) : null;
    if (!own && ownerAppId && !app.allowedSkills.includes(name)) return null;
    const skill = own || (await skillRepository.findByName(name));
    if (!skill || !skill.enabled) return null;
    return { name, skillId: skill.id, checksum: skill.checksum };
};

/**
 * Worker: what an attempt needs to mount its skill and the skills it uses.
 * @param {{skillId?: string, skillName: string}} job
 * @param {{skillChecksum: string, manifest: Object}} attempt
 * @param {{id: string}} app
 * @returns {Promise<{ownerAppId: string|null, skills: Array<{name: string, skillId: string, checksum: string}>}>}
 * @throws {ValidationError} when a skill the attempt needs is no longer available (permanent: not retried)
 */
const runPlanInternal = async (job, attempt, app) => {
    const skill = job.skillId
        ? await skillRepository.findByIdInternal(job.skillId)
        : await skillRepository.findByName(job.skillName);
    if (!skill) throw new ValidationError(`Skill '${job.skillName}' no longer exists.`);
    const blocked = appSkillBlockReason({ ...skill, manifest: attempt.manifest }, app);
    if (blocked) throw new ValidationError(blocked);
    const uses = [];
    for (const name of attempt.manifest.uses || []) {
        const used = await resolveUse(app, skill.appId, name);
        if (!used) throw new ValidationError(`Skill '${name}' used by '${skill.name}' is not available.`);
        uses.push(used);
    }
    return {
        ownerAppId: skill.appId || null,
        skills: [{ name: skill.name, skillId: skill.id, checksum: attempt.skillChecksum }, ...uses],
    };
};

/**
 * Worker: the stored package for a skill's content checksum.
 * @param {string} skillId
 * @param {string} checksum
 * @returns {Promise<Buffer|null>}
 */
const getPackageInternal = (skillId, checksum) => skillVersionRepository.findPackageInternal(skillId, checksum);

// ---------------------------------------------------------------------------------------------
// App-facing reads and changes
// ---------------------------------------------------------------------------------------------

/**
 * Enabled skills the calling app can run: its own skills and the gateway skills it is granted.
 * @param {{id?: string, allowedSkills: string[]}} app
 * @returns {Promise<Object[]>}
 */
const listSkillsForApp = async (app) => {
    const [own, gateway] = await Promise.all([
        usesOwnSkills(app) ? skillRepository.listOwned(app.id) : [],
        skillRepository.findByNames(app.allowedSkills),
    ]);
    const ownNames = new Set(own.map((s) => s.name));
    return [...own, ...gateway.filter((s) => !ownNames.has(s.name))]
        .filter((s) => s.enabled)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toPublicSkill);
};

/**
 * One skill the app can run; its own skills include their versions.
 * @param {{id?: string, allowedSkills: string[]}} app
 * @param {string} name
 * @returns {Promise<Object>}
 * @throws {ForbiddenError} FORBIDDEN_SKILL when the app may not use it
 * @throws {NotFoundError} SKILL_NOT_FOUND when missing or disabled
 */
const describeOwnSkill = async (skill) => {
    const versions = await skillVersionRepository.listBySkill(skill.id);
    return {
        ...toPublicSkill(skill),
        enabled: skill.enabled,
        disabledReason: skill.disabledReason,
        versions: versions.map(toPublicVersion),
    };
};

/** The app's own skill as getSkillForApp shows it (after a change through the skillsManageActive routes). */
const getOwnSkill = async (appId, name) => {
    const skill = await skillRepository.findOwnedByName(appId, name);
    if (!skill || skill.disabledReason === DISABLED.DELETED) throw skillNotFound(name);
    return describeOwnSkill(skill);
};

const getSkillForApp = async (app, name) => {
    const found = usesOwnSkills(app) ? await skillRepository.findOwnedByName(app.id, name) : null;
    if (found && found.disabledReason !== DISABLED.DELETED) return describeOwnSkill(found);
    if (!app.allowedSkills.includes(name)) {
        throw new ForbiddenError(`This app may not use skill '${name}'.`, API_ERROR.FORBIDDEN_SKILL);
    }
    const skill = await skillRepository.findByName(name);
    if (!skill || !skill.enabled) throw skillNotFound(name);
    return toPublicSkill(skill);
};

const ownedOrNotFound = async (appId, name, transaction) => {
    const skill = await skillRepository.findOwnedByName(appId, name, { transaction, lock: true });
    if (!skill || skill.disabledReason === DISABLED.DELETED) throw skillNotFound(name);
    return skill;
};

/** Point the skill at its highest enabled version, or disable it when none is left. */
const refreshLatest = async (skill, transaction) => {
    const latest = await skillVersionRepository.findLatestEnabled(skill.id, { transaction });
    if (latest) {
        const reenable = skill.disabledReason === DISABLED.NO_VERSION ? { enabled: true, disabledReason: null } : {};
        await skillRepository.updateById(skill.id, { ...latestFields(latest), ...reenable }, { transaction });
    } else if (skill.enabled) {
        await skillRepository.updateById(
            skill.id,
            { enabled: false, disabledReason: DISABLED.NO_VERSION },
            { transaction },
        );
    }
};

const auditSkill = ({ appId, skill, action, details = {} }, transaction) =>
    recordAudit(
        { appId, action, targetType: 'skill', targetId: skill.id, details: { name: skill.name, ...details } },
        { transaction },
    );

/**
 * Enable or disable one of the app's own skills.
 * @param {string} appId
 * @param {string} name
 * @param {boolean} enabled
 * @returns {Promise<Object>} the skill as getSkillForApp shows it
 * @throws {NotFoundError} SKILL_NOT_FOUND
 */
const setSkillEnabled = async (appId, name, enabled) => {
    await withTransaction('skill.setEnabled', async (transaction) => {
        const skill = await ownedOrNotFound(appId, name, transaction);
        await skillRepository.updateById(
            skill.id,
            enabled ? { enabled: true, disabledReason: null } : { enabled: false, disabledReason: DISABLED.BY_APP },
            { transaction },
        );
        if (enabled) await refreshLatest({ ...skill, enabled: true, disabledReason: null }, transaction);
        await auditSkill({ appId, skill, action: AUDIT_ACTION.SKILL_UPDATED, details: { enabled } }, transaction);
    });
    return getOwnSkill(appId, name);
};

/**
 * Enable or disable one version of the app's own skill. The skill then runs its newest enabled version.
 * @param {string} appId
 * @param {string} name
 * @param {string} version
 * @param {boolean} enabled
 * @returns {Promise<Object>}
 * @throws {NotFoundError} SKILL_NOT_FOUND
 */
const setVersionEnabled = async (appId, name, version, enabled) => {
    await withTransaction('skill.setVersionEnabled', async (transaction) => {
        const skill = await ownedOrNotFound(appId, name, transaction);
        const row = await skillVersionRepository.findBySkillAndVersion(skill.id, version, { transaction });
        if (!row)
            throw new NotFoundError(`Version ${version} of skill '${name}' was not found.`, API_ERROR.SKILL_NOT_FOUND);
        await skillVersionRepository.updateById(row.id, { enabled }, { transaction });
        await refreshLatest(skill, transaction);
        await auditSkill(
            { appId, skill, action: AUDIT_ACTION.SKILL_UPDATED, details: { version, enabled } },
            transaction,
        );
    });
    return getOwnSkill(appId, name);
};

/**
 * Delete one of the app's own skills: new jobs stop at once; rows go with retention.
 * The row gives up its name, so uploading the name again starts it afresh.
 * @param {string} appId
 * @param {string} name
 * @returns {Promise<void>}
 * @throws {NotFoundError} SKILL_NOT_FOUND
 */
const deleteSkill = async (appId, name) => {
    await withTransaction('skill.delete', async (transaction) => {
        const skill = await ownedOrNotFound(appId, name, transaction);
        await markDeleted(skill, transaction);
        await auditSkill({ appId, skill, action: AUDIT_ACTION.SKILL_DELETED }, transaction);
    });
};

module.exports = {
    inspectPackage,
    syncFromDisk,
    syncGatewaySkills,
    resyncGatewaySkills,
    addVersion,
    resolveForJob,
    resolveSkill,
    resolveForClaimInternal,
    runPlanInternal,
    appSkillBlockReason,
    getPackageInternal,
    listSkillsForApp,
    getSkillForApp,
    setSkillEnabled,
    setVersionEnabled,
    deleteSkill,
    DISABLED,
    VERSION_STATUS,
};
