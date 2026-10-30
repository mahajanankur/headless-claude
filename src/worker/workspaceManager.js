'use strict';

const fs = require('fs');
const path = require('path');

const { PATHS } = require('../../config/paths');

const { writeFileAtomic } = require('../utils/safeFs');

/**
 * Host-side directories for one attempt:
 *   <jobs>/<jobId>/a<n>/ run/ (stream, exit) · control/ (cancel) · meta/ (settings, read-only) · secret/ (env file, never mounted)
 *   ws/  Claude's working directory (input.json, repo/, out/) — reused across attempts for resume and sessions
 *   <apps>/<appId>/home  the app's Claude home (HOME + CLAUDE_CONFIG_DIR)
 * @param {{jobId: string, appId: string, attemptN: number, wsDir?: string}} options wsDir overrides the workspace
 * @returns {{attemptDir: string, runDir: string, controlDir: string, metaDir: string, secretDir: string, wsDir: string, homeDir: string}}
 */
const attemptDirs = ({ jobId, appId, attemptN, wsDir }) => {
    const attemptDir = path.join(PATHS.jobsDir, jobId, `a${attemptN}`);
    return {
        attemptDir,
        runDir: path.join(attemptDir, 'run'),
        controlDir: path.join(attemptDir, 'control'),
        metaDir: path.join(attemptDir, 'meta'),
        secretDir: path.join(attemptDir, 'secret'),
        wsDir: wsDir || path.join(attemptDir, 'ws'),
        homeDir: path.join(PATHS.appsDir, appId, 'home'),
    };
};

/**
 * Create the directories and write input.json and the read-only settings file.
 * @param {Object} dirs from attemptDirs
 * @param {{input: Object, settings: Object, mcpConfig?: Object}} files
 * @returns {{settingsFile: string, mcpConfigFile: string|null}}
 */
const prepareAttempt = (dirs, { input, settings, mcpConfig }) => {
    [
        dirs.runDir,
        dirs.controlDir,
        dirs.metaDir,
        dirs.wsDir,
        path.join(dirs.wsDir, 'out'),
        path.join(dirs.homeDir, '.claude'),
    ].forEach((d) => fs.mkdirSync(d, { recursive: true, mode: 0o750 }));
    fs.mkdirSync(dirs.secretDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(dirs.wsDir, 'input.json'), JSON.stringify(input, null, 2));
    const settingsFile = path.join(dirs.metaDir, 'settings.json');
    writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2));
    fs.chmodSync(settingsFile, 0o444);
    let mcpConfigFile = null;
    if (mcpConfig && Object.keys(mcpConfig).length) {
        mcpConfigFile = path.join(dirs.metaDir, 'mcp.json');
        writeFileAtomic(mcpConfigFile, JSON.stringify({ mcpServers: mcpConfig }, null, 2));
        fs.chmodSync(mcpConfigFile, 0o444);
    }
    return { settingsFile, mcpConfigFile };
};

/**
 * Write a 0600 env file for runners that pass the environment by file (docker, host).
 * @param {Object} dirs
 * @param {Object<string, string>} env
 * @returns {string} path
 */
const writeEnvFile = (dirs, env) => {
    const file = path.join(dirs.secretDir, 'env');
    const body = Object.entries(env)
        .map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`)
        .join('\n');
    fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
    return file;
};

/** @param {Object} dirs @returns {void} */
const removeSecrets = (dirs) => fs.rmSync(dirs.secretDir, { recursive: true, force: true });

/** @param {Object} dirs @returns {boolean} */
const hasExit = (dirs) => fs.existsSync(path.join(dirs.runDir, 'exit.json'));

/** @param {Object} dirs @returns {Object|null} */
const readExit = (dirs) =>
    hasExit(dirs) ? JSON.parse(fs.readFileSync(path.join(dirs.runDir, 'exit.json'), 'utf8')) : null;

/** @param {Object} dirs @returns {string} */
const streamFile = (dirs) => path.join(dirs.runDir, 'stream.jsonl');

/**
 * Ask ccwrap to stop the run; the content is the reason recorded in exit.json.
 * @param {Object} dirs
 * @param {string} reason cancel | budget
 * @returns {void}
 */
const requestStop = (dirs, reason) => {
    const file = path.join(dirs.controlDir, 'cancel');
    if (!fs.existsSync(file)) fs.writeFileSync(file, reason);
};

/** Persist the finished outcome before the DB write, so it survives a DB outage or a restart. */
const writeResultRecord = (dirs, record) =>
    writeFileAtomic(path.join(dirs.attemptDir, 'result.json'), JSON.stringify(record));

/** @param {Object} dirs @returns {Object|null} */
const readResultRecord = (dirs) => {
    const file = path.join(dirs.attemptDir, 'result.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

/**
 * Delete a job's attempt directories (and the workspace when it lives there).
 * @param {string} jobId
 * @returns {void}
 */
const removeJobDirs = (jobId) => fs.rmSync(path.join(PATHS.jobsDir, jobId), { recursive: true, force: true });

module.exports = {
    attemptDirs,
    prepareAttempt,
    writeEnvFile,
    removeSecrets,
    hasExit,
    readExit,
    streamFile,
    requestStop,
    writeResultRecord,
    readResultRecord,
    removeJobDirs,
};
