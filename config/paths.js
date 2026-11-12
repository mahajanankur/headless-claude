'use strict';

const os = require('os');
const path = require('path');

const config = require('./index');

/** The package itself: code, ccwrap, built-in skills. */
const ROOT_DIR = path.resolve(__dirname, '..');
/** The working folder (GW_HOME, set by the config loader): data, secrets, shared skills. */
const HOME_DIR = process.env.GW_HOME || process.cwd();
const fromRoot = (p) => (path.isAbsolute(p) ? p : path.join(ROOT_DIR, p));
const toAbsolute = (p) => (path.isAbsolute(p) ? p : path.join(HOME_DIR, p));

const dataDir = toAbsolute(config.get('paths.dataDir'));

/** Absolute paths, computed once from config. */
const PATHS = Object.freeze({
    rootDir: ROOT_DIR,
    homeDir: HOME_DIR,
    dataDir,
    jobsDir: path.join(dataDir, 'jobs'),
    appsDir: path.join(dataDir, 'apps'),
    gitDir: path.join(dataDir, 'git'),
    skillsDir: fromRoot(config.get('paths.skillsDir')),
    sharedSkillsDir: config.get('paths.sharedSkillsDir') ? toAbsolute(config.get('paths.sharedSkillsDir')) : null,
    skillCacheDir: path.join(dataDir, 'skill-cache'),
    skillSyncDir: path.join(dataDir, 'skill-sync'),
    secretsFile: toAbsolute(config.get('paths.secretsFile')),
});

/** Host-derived values, computed once. */
const HOST = Object.freeze({
    hostId: config.get('worker.hostId') || os.hostname(),
    nodeBin: process.execPath,
});

module.exports = { PATHS, HOST };
