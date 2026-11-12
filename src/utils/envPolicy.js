'use strict';

const { SAFE_ENV_NAME, BLOCKED_ENV_PREFIXES, BLOCKED_ENV_SUFFIXES, BLOCKED_ENV_NAMES } = require('../constants/skill');

/**
 * Whether a skill manifest may set this environment variable for the Claude process.
 * Uppercase names only; never one that redirects Claude, loads code or replaces a gateway value.
 * @param {string} name
 * @returns {boolean}
 */
const isAllowedSkillEnvName = (name) =>
    SAFE_ENV_NAME.test(name) &&
    !BLOCKED_ENV_NAMES.includes(name) &&
    !BLOCKED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
    !BLOCKED_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix));

module.exports = { isAllowedSkillEnvName };
