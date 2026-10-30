'use strict';

const fs = require('fs');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const { addSecret } = require('../utils/redactor');

/**
 * Secrets file (optional, git-ignored, mode 0600):
 * {
 *   "claudeOauthToken": "...",            // used when CLAUDE_CODE_OAUTH_TOKEN is not set
 *   "anthropicApiKey": "...",
 *   "streamTokenSecret": "...",
 *   "encryptionKey": "<64 hex>",
 *   "langfusePublicKey": "pk-lf-...", "langfuseSecretKey": "sk-lf-...",   // optional tracing
 *   "values": { "<name>": "..." },        // referenced by manifests as "secret:<name>"
 *   "git": { "<ref>": { "username": "...", "token": "..." } }
 * }
 */
let cache = null;

const readFile = () => {
    if (!fs.existsSync(PATHS.secretsFile)) return {};
    return JSON.parse(fs.readFileSync(PATHS.secretsFile, 'utf8'));
};

const registerAll = (value) => {
    if (typeof value === 'string') addSecret(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(registerAll);
};

const load = () => {
    const file = readFile();
    // an explicitly configured value (env var) wins over the file, so rotation through the environment is never shadowed
    const pick = (key) => config.get(`secrets.${key}`) || file[key] || '';
    const secrets = Object.freeze({
        claudeOauthToken: pick('claudeOauthToken'),
        anthropicApiKey: pick('anthropicApiKey'),
        streamTokenSecret: pick('streamTokenSecret'),
        encryptionKey: pick('encryptionKey'),
        langfusePublicKey: pick('langfusePublicKey'),
        langfuseSecretKey: pick('langfuseSecretKey'),
        values: Object.freeze({ ...(file.values || {}) }),
        git: Object.freeze({ ...(file.git || {}) }),
    });
    registerAll(secrets);
    return secrets;
};

/**
 * All secrets, loaded once and registered with the redactor.
 * @returns {Object}
 */
const getSecrets = () => {
    if (!cache) cache = load();
    return cache;
};

/**
 * Fail fast at boot when a required secret is missing.
 * @param {string[]} names keys of getSecrets()
 * @returns {void}
 * @throws {Error}
 */
const requireSecrets = (names) => {
    const secrets = getSecrets();
    const missing = names.filter((n) => !secrets[n]);
    if (missing.length)
        throw new Error(`Missing required secrets: ${missing.join(', ')} (env or ${PATHS.secretsFile}).`);
};

/** Test hook: forget the cached secrets. */
const resetSecretsCache = () => {
    cache = null;
};

module.exports = { getSecrets, requireSecrets, resetSecretsCache };
