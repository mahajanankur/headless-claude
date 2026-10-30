'use strict';

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { sha256 } = require('./hash');

// addUsedSchema: false → schemas with `$id` are not registered globally, so the same schema can be
// compiled again (e.g. a new copy read from the DB) without "schema already exists" errors.
const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
addFormats(ajv);

// Keyed by content, not object identity: schemas read from JSONB are new objects on every query.
const compiled = new Map();

const compile = (schema) => {
    const key = sha256(JSON.stringify(schema));
    if (!compiled.has(key)) compiled.set(key, ajv.compile(schema));
    return compiled.get(key);
};

/**
 * Check that a value is a compilable JSON schema.
 * @param {Object} schema
 * @returns {string|null} the compile error message, or null when valid
 */
const schemaError = (schema) => {
    try {
        compile(schema);
        return null;
    } catch (error) {
        return error.message;
    }
};

/**
 * Validate data against a JSON schema (skill input/output contracts, manifests).
 * @param {Object|null} schema
 * @param {*} data
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 */
const validateSchema = (schema, data) => {
    if (!schema) return { valid: true, errors: [] };
    const fn = compile(schema);
    if (fn(data)) return { valid: true, errors: [] };
    return { valid: false, errors: fn.errors.map((e) => ({ path: e.instancePath || '/', message: e.message })) };
};

module.exports = { validateSchema, schemaError };
