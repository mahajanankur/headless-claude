'use strict';

const path = require('path');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const { run } = require('./runners/base.runner');

const IMAGE = config.get('runner.dockerImage');

/**
 * Absolute path of the claude binary: absolute as-is, relative paths from the repo root, bare names via PATH.
 * @param {string} bin
 * @returns {Promise<string|null>}
 */
const resolveBinary = async (bin) => {
    if (path.isAbsolute(bin)) return bin;
    if (bin.includes('/')) return path.resolve(PATHS.rootDir, bin);
    const { stdout, code } = await run('/bin/sh', ['-c', `command -v ${JSON.stringify(bin)}`]);
    return code === 0 && stdout.trim() ? stdout.trim() : null;
};

/**
 * Claude Code version available to the configured runner.
 * @param {{runnerName: string, claudeBin: string|null}} options
 * @returns {Promise<{claudeVersion: string|null, ok: boolean, error?: string}>}
 */
const checkClaude = async ({ runnerName, claudeBin }) => {
    const result =
        runnerName === 'docker'
            ? await run('docker', [
                  'run',
                  '--rm',
                  '--network',
                  'none',
                  IMAGE,
                  config.get('runner.containerClaudeBin'),
                  '--version',
              ])
            : await run(claudeBin || 'claude', ['--version']);
    const version = (result.stdout.match(/\d+\.\d+\.\d+/) || [null])[0];
    const pinned = config.get('llm.pinnedVersion');
    if (!version)
        return { claudeVersion: null, ok: false, error: result.stderr.trim().slice(0, 200) || 'claude not found' };
    if (pinned && pinned !== version)
        return { claudeVersion: version, ok: false, error: `Pinned ${pinned}, found ${version}` };
    return { claudeVersion: version, ok: true };
};

module.exports = { resolveBinary, checkClaude };
