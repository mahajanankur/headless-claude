'use strict';

const { execFile } = require('child_process');

/**
 * Runner contract (rules §11). Implementations never touch the database.
 *   sandboxPaths(dirs, skills) → paths as seen inside the sandbox
 *   start(spec)                → opaque handle (JSON-serialisable, stored on the attempt)
 *   isAlive(handle)            → Promise<boolean>
 *   destroy(handle)            → Promise<void>, idempotent
 * Cancellation is a file (control/cancel) read by ccwrap, so it works the same for every runner.
 */

/**
 * execFile as a promise; resolves { stdout, stderr, code } and never throws on a non-zero exit.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Object} [options]
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
const run = (cmd, args, options = {}) =>
    new Promise((resolve) => {
        execFile(cmd, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ stdout: String(stdout), stderr: String(stderr || (error && error.message) || ''), code });
        });
    });

module.exports = { run };
