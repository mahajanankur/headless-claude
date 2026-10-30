'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { HOST, PATHS } = require('../../../config/paths');

/**
 * Local runner (macOS / Linux development only): ccwrap runs as a detached process of this user.
 * The worker can restart without stopping it. Never used in production (runnerFactory refuses).
 */
const CCWRAP = path.join(PATHS.rootDir, 'src', 'worker', 'runners', 'wrapper', 'ccwrap.js');

/**
 * @param {Object} dirs host directories
 * @param {Object<string, string>} skills skill name → host dir
 * @returns {Object} identical host paths
 */
const sandboxPaths = (dirs, skills) => ({
    ws: dirs.wsDir,
    run: dirs.runDir,
    control: dirs.controlDir,
    meta: dirs.metaDir,
    home: dirs.homeDir,
    skills,
    settingsFile: path.join(dirs.metaDir, 'settings.json'),
    mcpConfigFile: fs.existsSync(path.join(dirs.metaDir, 'mcp.json')) ? path.join(dirs.metaDir, 'mcp.json') : null,
});

/**
 * @param {{dirs: Object, claudeBin: string, args: string[], env: Object, wrapArgs: string[]}} spec
 * @returns {Promise<{kind: string, pid: number, startedAt: string}>}
 */
const start = async ({ dirs, claudeBin, args, env, wrapArgs }) => {
    const child = spawn(HOST.nodeBin, [CCWRAP, ...wrapArgs, '--', claudeBin, ...args], {
        cwd: dirs.wsDir,
        env,
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    return { kind: 'local', pid: child.pid, startedAt: new Date().toISOString() };
};

const pidMatches = (handle, dirs) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(dirs.runDir, 'pid.json'), 'utf8')).wrapperPid === handle.pid;
    } catch {
        return true; // pid.json not written yet: trust the pid
    }
};

/**
 * @param {{pid: number}} handle
 * @param {Object} dirs
 * @returns {Promise<boolean>}
 */
const isAlive = async (handle, dirs) => {
    try {
        process.kill(handle.pid, 0);
        return pidMatches(handle, dirs);
    } catch {
        return false;
    }
};

/**
 * @param {{pid: number}} handle
 * @returns {Promise<void>}
 */
const destroy = async (handle) => {
    try {
        process.kill(-handle.pid, 'SIGKILL');
    } catch {
        // already gone
    }
};

module.exports = { name: 'local', sandboxOn: true, usesEnvFile: false, sandboxPaths, start, isAlive, destroy };
