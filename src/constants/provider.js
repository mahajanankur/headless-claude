'use strict';

/** provider_state keys. Pause keys are `pause:<scope>`. */
const PROVIDER_KEY = Object.freeze({
    USAGE: 'usage',
    HEALTH: 'health',
    INTAKE: 'intake',
    pause: (scope) => `pause:${scope}`,
});

/** Limit scopes: global pauses everything; a model family pauses only that model's jobs. */
const LIMIT_SCOPE = Object.freeze({
    GLOBAL: 'global',
    model: (family) => `model:${family}`,
});

const MODEL_FAMILIES = Object.freeze(['opus', 'sonnet', 'haiku']);

/**
 * @param {string} model alias ('sonnet') or full id ('claude-sonnet-5-5')
 * @returns {string} family, or the model string itself when unknown
 */
const modelFamily = (model) => MODEL_FAMILIES.find((f) => String(model).toLowerCase().includes(f)) || String(model);

module.exports = { PROVIDER_KEY, LIMIT_SCOPE, MODEL_FAMILIES, modelFamily };
