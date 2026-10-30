'use strict';

const os = require('os');
const path = require('path');

const config = require('./index');

const ROOT_DIR = path.resolve(__dirname, '..');
const toAbsolute = (p) => (path.isAbsolute(p) ? p : path.join(ROOT_DIR, p));

const dataDir = toAbsolute(config.get('paths.dataDir'));

/** Absolute paths, computed once from config. */
const PATHS = Object.freeze({
    rootDir: ROOT_DIR,
    dataDir,
    jobsDir: path.join(dataDir, 'jobs'),
    appsDir: path.join(dataDir, 'apps'),
    gitDir: path.join(dataDir, 'git'),
    skillsDir: toAbsolute(config.get('paths.skillsDir')),
    secretsFile: toAbsolute(config.get('paths.secretsFile')),
});

/** Host-derived values, computed once. */
const HOST = Object.freeze({
    hostId: config.get('worker.hostId') || os.hostname(),
    nodeBin: process.execPath,
});

module.exports = { PATHS, HOST };
