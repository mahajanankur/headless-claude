'use strict';

const config = require('../../../config');

const localRunner = require('./local.runner');
const dockerRunner = require('./docker.runner');
const hostRunner = require('./host.runner');

const RUNNERS = Object.freeze({ local: localRunner, docker: dockerRunner, host: hostRunner });

/**
 * The configured runner. `local` is refused in production (rules §11 Runners).
 * @param {string} [mode]
 * @returns {Object}
 * @throws {Error}
 */
const getRunner = (mode = config.get('runner.mode')) => {
    const runner = RUNNERS[mode];
    if (!runner) throw new Error(`Unknown runner mode '${mode}' (expected ${Object.keys(RUNNERS).join(', ')}).`);
    if (mode === 'local' && config.util.getEnv('NODE_ENV') === 'production') {
        throw new Error('The local runner is not allowed in production. Use docker or host.');
    }
    return runner;
};

/**
 * Runner by name, for re-attaching attempts started under a previous configuration.
 * @param {string} kind
 * @returns {Object}
 */
const runnerFor = (kind) => RUNNERS[kind] || getRunner();

/**
 * Claude's own sandbox applies when the runner relies on it and the operator did not turn it off.
 * @param {Object} runner
 * @returns {boolean}
 */
const isSandboxOn = (runner) => runner.sandboxOn && config.get('runner.sandbox') === 'required';

module.exports = { getRunner, runnerFor, isSandboxOn };
