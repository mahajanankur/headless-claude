'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { promisify } = require('util');
const zlib = require('zlib');

const tar = require('tar');

/** Per-entry tar header and padding allowance used when bounding the decompressed size. */
const TAR_OVERHEAD_PER_ENTRY = 1024;
const gunzip = promisify(zlib.gunzip);
const ALLOWED_TYPES = Object.freeze(['File', 'OldFile', 'Directory']);

/** Rejected package: carries a reason safe to show to the caller. */
class PackageError extends Error {}

const normalise = (entryPath) => entryPath.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/**
 * Whether an archive path is allowed in a skill package: manifest.json or anything under .claude/,
 * relative, with no parent segments.
 * @param {string} entryPath
 * @returns {boolean}
 */
const isAllowedPath = (entryPath) => {
    const p = normalise(entryPath);
    if (!p || path.isAbsolute(entryPath) || p.includes('\\')) return false;
    if (p.split('/').some((segment) => segment === '..' || segment === '')) return false;
    return p === 'manifest.json' || p === '.claude' || p.startsWith('.claude/');
};

/**
 * Pack a skill folder (manifest.json and .claude/) into a gzipped tar. Symlinks and other
 * non-regular entries are left out.
 * @param {string} dir skill folder
 * @returns {Promise<Buffer>}
 */
const pack = async (dir) => {
    const entries = ['manifest.json', '.claude'].filter((name) => fs.existsSync(path.join(dir, name)));
    const chunks = [];
    const stream = tar.c(
        {
            gzip: true,
            cwd: dir,
            portable: true,
            noMtime: true,
            filter: (entryPath, stat) => stat.isFile() || stat.isDirectory(),
        },
        entries,
    );
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
};

// async: decompression runs on the libuv pool, not the API's event loop
const gunzipBounded = async (buffer, { maxUnpackedBytes, maxFiles }) => {
    try {
        return await gunzip(buffer, { maxOutputLength: maxUnpackedBytes + (maxFiles + 2) * TAR_OVERHEAD_PER_ENTRY });
    } catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
            throw new PackageError(`Package unpacks to more than ${maxUnpackedBytes} bytes.`);
        }
        throw new PackageError('Package is not a valid gzip file.');
    }
};

/**
 * Entry checks applied to every archive member (rules: regular files and directories only,
 * manifest.json and .claude/ only, caps on file count and unpacked bytes).
 * @returns {{filter: Function, problems: string[]}}
 */
const entryGuard = ({ maxUnpackedBytes, maxFiles }) => {
    const state = { files: 0, bytes: 0, problems: [] };
    const reject = (reason) => {
        if (state.problems.length < 5) state.problems.push(reason);
        return false;
    };
    const filter = (entryPath, entry) => {
        if (!ALLOWED_TYPES.includes(entry.type)) return reject(`${entryPath}: ${entry.type} entries are not allowed`);
        if (!isAllowedPath(entryPath)) return reject(`${entryPath}: only manifest.json and .claude/ are allowed`);
        if (entry.type === 'Directory') return true;
        state.files += 1;
        state.bytes += entry.size || 0;
        if (state.files > maxFiles) return reject(`more than ${maxFiles} files`);
        if (state.bytes > maxUnpackedBytes) return reject(`more than ${maxUnpackedBytes} bytes unpacked`);
        return true;
    };
    return { filter, problems: state.problems };
};

/**
 * Unpack a gzipped skill package into an empty directory, rejecting anything unsafe
 * (symlinks, hard links, devices, absolute or parent paths, files outside manifest.json/.claude,
 * size and count caps). Files are written 0644 and directories 0755, owned by the current user.
 * @param {Buffer} buffer gzipped tar
 * @param {string} targetDir directory to create and fill
 * @param {{maxUnpackedBytes: number, maxFiles: number}} limits
 * @returns {Promise<void>}
 * @throws {PackageError} when the package is rejected
 */
const unpack = async (buffer, targetDir, limits) => {
    const raw = await gunzipBounded(buffer, limits);
    const { filter, problems } = entryGuard(limits);
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    try {
        await pipeline(
            Readable.from([raw]),
            tar.x({
                cwd: targetDir,
                strict: true,
                filter,
                preserveOwner: false,
                noChmod: true,
                dmode: 0o755,
                fmode: 0o644,
            }),
        );
    } catch (error) {
        throw new PackageError(`Package is not a valid tar archive: ${error.message}`);
    }
    if (problems.length) throw new PackageError(`Package rejected: ${problems.join('; ')}.`);
    normaliseModes(targetDir);
};

/**
 * Set every directory to 0755 and every file to 0644 (no executables, no setuid), without following links.
 * @param {string} dir
 * @returns {void}
 */
const normaliseModes = (dir) => {
    fs.chmodSync(dir, 0o755);
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) normaliseModes(full);
        else if (entry.isFile()) fs.chmodSync(full, 0o644);
        else fs.rmSync(full, { force: true });
    });
};

module.exports = { pack, unpack, isAllowedPath, PackageError };
