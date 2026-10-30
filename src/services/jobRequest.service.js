'use strict';

const config = require('../../config');

const { validateSchema } = require('../utils/jsonSchema');
const { ValidationError, ForbiddenError } = require('../utils/AppError');
const { modelFamily } = require('../constants/provider');
const { CHANGE_MODE } = require('../constants/skill');
const { API_ERROR } = require('../constants/apiErrors');

const MAX_INPUT_BYTES = config.get('job.maxInputBytes');
const MIN_TIMEOUT_SEC = config.get('job.minTimeoutSec');
const GLOBAL_MODELS = config.get('llm.allowedModels');
const GIT_ALLOWED_HOSTS = config.get('git.allowedHosts');
const ALLOW_FILE_REPOS = config.get('git.allowFileUrls');

const isModelAllowed = (model, allowed) => allowed.includes(model) || allowed.includes(modelFamily(model));

/**
 * Pick and authorise the model (decision D15).
 * @param {string|undefined} requested
 * @param {Object} manifest
 * @param {{allowedModels: string[]}} app
 * @returns {string}
 * @throws {ForbiddenError}
 */
const resolveModel = (requested, manifest, app) => {
    const model = requested || manifest.defaultModel;
    if (!isModelAllowed(model, app.allowedModels) || !isModelAllowed(model, GLOBAL_MODELS)) {
        throw new ForbiddenError(`This app may not use model '${model}'.`, API_ERROR.FORBIDDEN_MODEL);
    }
    return model;
};

/**
 * @param {Object} input
 * @param {Object} manifest
 * @returns {void}
 * @throws {ValidationError}
 */
const validateInput = (input, manifest) => {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
        throw new ValidationError(`Input (input) must be at most ${MAX_INPUT_BYTES} bytes.`);
    }
    const { valid, errors } = validateSchema(manifest.inputSchema, input);
    if (!valid) throw new ValidationError('Input (input) does not match the skill input schema.', errors);
};

/**
 * @param {number|undefined} requested
 * @param {Object} manifest
 * @returns {number}
 * @throws {ValidationError}
 */
const resolveTimeout = (requested, manifest) => {
    if (requested === undefined) return manifest.timeoutSec;
    if (requested < MIN_TIMEOUT_SEC || requested > manifest.timeoutSec) {
        throw new ValidationError(
            `Timeout (timeoutSec) must be between ${MIN_TIMEOUT_SEC} and ${manifest.timeoutSec}.`,
        );
    }
    return requested;
};

const checkRepoUrl = (rawUrl) => {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new ValidationError('Repository URL is not valid.');
    }
    if (url.protocol === 'file:' && ALLOW_FILE_REPOS) return;
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new ValidationError('Repository URL must be https without embedded credentials.');
    }
    if (!GIT_ALLOWED_HOSTS.includes(url.hostname))
        throw new ValidationError(`Repository host ${url.hostname} is not allowed.`);
};

/**
 * Repository to clone for this job, from the manifest's repo mapping.
 * @param {Object} input
 * @param {Object} manifest
 * @returns {{repoUrl: string|null, repoRef: string|null}}
 * @throws {ValidationError}
 */
const resolveRepo = (input, manifest) => {
    if (!manifest.repo) return { repoUrl: null, repoRef: null };
    const repoUrl = input[manifest.repo.urlFromInput];
    if (typeof repoUrl !== 'string' || !repoUrl) {
        throw new ValidationError(`Repository (${manifest.repo.urlFromInput}) is required by this skill.`);
    }
    checkRepoUrl(repoUrl);
    const ref = (manifest.repo.refFromInput && input[manifest.repo.refFromInput]) || manifest.repo.defaultRef || null;
    if (ref !== null && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref))
        throw new ValidationError('Repository ref (ref) is not valid.');
    return { repoUrl, repoRef: ref };
};

/**
 * Skills that change code can't share a session in v1 (decision D19 in architecture §4).
 * @param {Object} manifest
 * @returns {boolean}
 */
const allowsSessions = (manifest) => manifest.changes === CHANGE_MODE.NONE;

module.exports = { resolveModel, validateInput, resolveTimeout, resolveRepo, allowsSessions, isModelAllowed };
