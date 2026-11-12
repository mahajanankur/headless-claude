'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const skillService = require('../services/skill.service');
const { checksumFolder } = require('../services/skillFolder.service');
const { unpack } = require('../utils/skillPackage');
const { ValidationError } = require('../utils/AppError');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

const LIMITS = Object.freeze({
    maxUnpackedBytes: config.get('skills.maxUnpackedBytes'),
    maxFiles: config.get('skills.maxFiles'),
});
const TTL_MS = config.get('skills.cacheTtlHours') * 3600e3;
const CHECKSUM = /^[0-9a-f]{64}$/;

/** Make a tree read-only (dirs 0555, files 0444) or writable again (0755/0644), never following links. */
const setTreeMode = (dir, writable) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (writable) fs.chmodSync(full, 0o755);
            setTreeMode(full, writable);
            if (!writable) fs.chmodSync(full, 0o555);
        } else if (entry.isFile()) fs.chmodSync(full, writable ? 0o644 : 0o444);
    });
    fs.chmodSync(dir, writable ? 0o755 : 0o555);
};

const removeTree = (dir) => {
    if (!fs.existsSync(dir)) return;
    try {
        setTreeMode(dir, true);
    } catch {
        // best effort: removal below still works for the owner or root
    }
    fs.rmSync(dir, { recursive: true, force: true });
};

const touch = (dir) => {
    const now = new Date();
    fs.utimesSync(dir, now, now);
};

/**
 * Directory holding the unpacked skill version with this content checksum, unpacking it from the
 * stored package on first use. The result is read-only and shared by every attempt on this host.
 * @param {{skillId: string, checksum: string}} version
 * @returns {Promise<string>} absolute directory (same layout as a skill folder)
 * @throws {ValidationError} when the package is missing or does not match its checksum (permanent)
 */
const ensure = async ({ skillId, checksum }) => {
    if (!CHECKSUM.test(checksum)) throw new ValidationError(`Invalid skill checksum '${checksum}'.`);
    const dir = path.join(PATHS.skillCacheDir, checksum);
    if (fs.existsSync(dir)) {
        touch(dir);
        return dir;
    }
    const buffer = await skillService.getPackageInternal(skillId, checksum);
    if (!buffer)
        throw new ValidationError(`No stored package for skill ${skillId} with checksum ${checksum.slice(0, 12)}.`);
    fs.mkdirSync(PATHS.skillCacheDir, { recursive: true });
    const tmp = `${dir}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
        await unpack(buffer, tmp, LIMITS);
        const actual = await checksumFolder(tmp);
        if (actual !== checksum) throw new ValidationError(`Skill package checksum mismatch (${actual.slice(0, 12)}).`);
        setTreeMode(tmp, false);
        fs.renameSync(tmp, dir);
    } catch (error) {
        removeTree(tmp);
        // another attempt unpacked the same version first: use theirs
        if (fs.existsSync(dir)) return dir;
        throw error;
    }
    return dir;
};

/**
 * Remove cached versions not used for skills.cacheTtlHours, and leftovers of interrupted unpacks.
 * @param {number} [now]
 * @returns {number} directories removed
 */
const prune = (now = Date.now()) => {
    if (!fs.existsSync(PATHS.skillCacheDir)) return 0;
    let removed = 0;
    fs.readdirSync(PATHS.skillCacheDir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(PATHS.skillCacheDir, entry.name);
        const stale = now - fs.statSync(full).mtimeMs > TTL_MS;
        const leftover = entry.name.includes('.tmp-') && now - fs.statSync(full).mtimeMs > 3600e3;
        if (entry.isDirectory() && (stale || leftover)) {
            removeTree(full);
            removed += 1;
        }
    });
    if (removed) logger.info(`Pruned ${removed} cached skill version(s).`);
    return removed;
};

module.exports = { ensure, prune };
