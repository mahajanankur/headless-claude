'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve `relative` under `root` and refuse anything that escapes it or passes through a symlink.
 * @param {string} root absolute directory
 * @param {string} relative
 * @returns {string} absolute path inside root
 * @throws {Error} when the path escapes root or any component is a symlink
 */
const resolveInside = (root, relative) => {
    const rootReal = fs.realpathSync(root);
    const target = path.resolve(rootReal, relative);
    if (target !== rootReal && !target.startsWith(rootReal + path.sep))
        throw new Error(`Path escapes workspace: ${relative}`);
    let current = rootReal;
    for (const part of path.relative(rootReal, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`Symlinks are not allowed: ${relative}`);
        }
    }
    return target;
};

/**
 * Read a regular file inside root without following symlinks, refusing files over maxBytes.
 * @param {string} root
 * @param {string} relative
 * @param {number} maxBytes
 * @returns {Buffer|null} null when the file does not exist
 * @throws {Error} on escape, symlink, non-regular file or size over the cap
 */
const readFileInside = (root, relative, maxBytes) => {
    const file = resolveInside(root, relative);
    if (!fs.existsSync(file)) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`Not a regular file: ${relative}`);
        if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${relative}`);
        return fs.readFileSync(fd);
    } finally {
        fs.closeSync(fd);
    }
};

/**
 * Regular files (recursive) under root/relativeDir; symlinks and special files are skipped.
 * @param {string} root
 * @param {string} relativeDir
 * @returns {string[]} paths relative to relativeDir
 */
const listRegularFiles = (root, relativeDir) => {
    const base = resolveInside(root, relativeDir);
    if (!fs.existsSync(base)) return [];
    const walk = (dir) =>
        fs
            .readdirSync(dir, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
            .flatMap((entry) => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) return walk(full);
                return entry.isFile() ? [path.relative(base, full)] : [];
            });
    return walk(base);
};

/**
 * Write a file atomically (write temp, then rename).
 * @param {string} file
 * @param {string|Buffer} content
 * @returns {void}
 */
const writeFileAtomic = (file, content) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
};

/**
 * Give a directory tree to another user. Uses lchown and never descends through symlinks, so a link planted in a
 * cloned repository cannot redirect the change outside the tree.
 * @param {string} root absolute path
 * @param {number} uid
 * @param {number} gid
 * @returns {void}
 */
const chownTree = (root, uid, gid) => {
    fs.lchownSync(root, uid, gid);
    if (!fs.lstatSync(root).isDirectory()) return;
    fs.readdirSync(root).forEach((name) => chownTree(path.join(root, name), uid, gid));
};

module.exports = { resolveInside, readFileInside, listRegularFiles, writeFileAtomic, chownTree };
