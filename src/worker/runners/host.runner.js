'use strict';

const path = require('path');

const config = require('../../../config');
const { HOST, PATHS } = require('../../../config/paths');

const { run } = require('./base.runner');

const HELPER = config.get('runner.hostHelper');
const RUN_AS = config.get('runner.runAsUser');
const CCWRAP = path.join(PATHS.rootDir, 'src', 'worker', 'runners', 'wrapper', 'ccwrap.js');

/**
 * Host runner (Linux): each attempt is a transient systemd unit running as the unprivileged `ccrunner`
 * user, started through a root-owned helper (ops/host/gw-runner-helper) allowed by a narrow sudoers rule.
 * Claude's own bubblewrap sandbox is required in this mode.
 */
const sandboxPaths = (dirs, skills) => ({
    ws: dirs.wsDir,
    run: dirs.runDir,
    control: dirs.controlDir,
    meta: dirs.metaDir,
    home: dirs.homeDir,
    skills,
    settingsFile: path.join(dirs.metaDir, 'settings.json'),
    mcpConfigFile: dirs.mcpConfigFile || null,
});

/**
 * Helper arguments: start <unit> <user> <memoryMax> <runtimeMaxSec> <workdir> <envFile> <attemptDir> -- cmd...
 * @param {Object} spec
 * @returns {string[]}
 */
const helperArgs = ({ dirs, envFile, args, wrapArgs, name, runtimeMaxSec, claudeBin }) => [
    '-n',
    HELPER,
    'start',
    name,
    RUN_AS,
    config.get('runner.memoryMax'),
    String(runtimeMaxSec),
    dirs.wsDir,
    envFile,
    dirs.attemptDir,
    '--',
    HOST.nodeBin,
    CCWRAP,
    ...wrapArgs,
    '--',
    claudeBin,
    ...args,
];

/**
 * @param {Object} spec
 * @returns {Promise<{kind: string, unit: string}>}
 */
const start = async (spec) => {
    const { stderr, code } = await run('sudo', helperArgs(spec));
    if (code !== 0) throw new Error(`gw-runner-helper start failed: ${stderr.trim().slice(0, 300)}`);
    return { kind: 'host', unit: spec.name };
};

/**
 * @param {{unit: string}} handle
 * @returns {Promise<boolean>}
 */
const isAlive = async (handle) => {
    const { stdout } = await run('systemctl', ['is-active', `${handle.unit}.service`]);
    return ['active', 'activating', 'deactivating'].includes(stdout.trim());
};

/**
 * @param {{unit: string}} handle
 * @returns {Promise<void>}
 */
const destroy = async (handle) => {
    await run('sudo', ['-n', HELPER, 'stop', handle.unit]);
};

module.exports = {
    name: 'host',
    sandboxOn: true,
    usesEnvFile: true,
    sandboxPaths,
    start,
    isAlive,
    destroy,
    helperArgs,
};
