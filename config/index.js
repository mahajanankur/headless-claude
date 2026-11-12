'use strict';

/**
 * Config loader: the single entry point for configuration.
 *
 * - Values live in this folder (node-config): default.json holds every key; development.json,
 *   test.json and production.json override only what differs; custom-environment-variables.json
 *   maps env vars (secrets included) onto keys.
 * - NODE_ENV defaults to `development`, the only environment that targets localhost.
 *   Never add config/local.json: node-config loads it in every environment, production included.
 * - Development loads `.env.local` first; tests take only TEST_DATABASE_URL from it; production never reads it.
 * - GW_HOME (default: the current directory) is the working folder: `.env.local` and relative data and
 *   secrets paths resolve there, so an npm-installed gateway keeps its state where it is run.
 *
 * Usage: const config = require('<path>/config'); config.get('worker.concurrency');
 */
const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');

const HOME_DIR = path.resolve(process.env.GW_HOME || process.cwd());
// children (API, worker, migrations) started by the CLI resolve the same working folder
process.env.GW_HOME = HOME_DIR;
const ENV_FILE = path.join(HOME_DIR, '.env.local');

const readEnvFile = () => (fs.existsSync(ENV_FILE) ? dotenv.parse(fs.readFileSync(ENV_FILE)) : {});

const ENVIRONMENTS = ['development', 'test', 'production'];

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
if (!ENVIRONMENTS.includes(process.env.NODE_ENV)) {
    // a typo such as "prod" would otherwise run with development settings and .env.local
    throw new Error(`NODE_ENV must be one of ${ENVIRONMENTS.join(', ')} (got '${process.env.NODE_ENV}').`);
}
if (process.env.NODE_ENV === 'test') {
    // tests are deterministic: only the test database URL is taken from .env.local, never dev overrides
    const testUrl = process.env.TEST_DATABASE_URL || readEnvFile().TEST_DATABASE_URL;
    if (testUrl) process.env.DATABASE_URL = testUrl;
} else if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: ENV_FILE, quiet: true });
}
process.env.NODE_CONFIG_DIR = __dirname;
process.env.SUPPRESS_NO_CONFIG_WARNING = 'y';

const config = require('config');

module.exports = config;
