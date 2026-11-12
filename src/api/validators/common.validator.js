'use strict';

const { body, param } = require('express-validator');

const { SKILL_NAME_PATTERN } = require('../../constants/skill');

/**
 * Reject body fields outside the allowed list (rules §13).
 * @param {string[]} allowed
 * @returns {Object} validation chain
 */
const onlyFields = (allowed) =>
    body().custom((value) => {
        if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Request body must be a JSON object.');
        }
        const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
        if (unknown.length) throw new Error(`Unknown field(s): ${unknown.join(', ')}.`);
        return true;
    });

/**
 * @param {string} name path parameter
 * @param {string} label human name
 * @returns {Object} validation chain
 */
const uuidParam = (name, label) => param(name).isUUID().withMessage(`${label} (${name}) must be a UUID.`);

const SKILL_NAME = SKILL_NAME_PATTERN;
const NAME = /^[A-Za-z0-9._ -]{1,100}$/;
/** A skill version as manifest.version requires it: major.minor.patch. */
const SKILL_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

module.exports = { onlyFields, uuidParam, SKILL_NAME, SKILL_VERSION, NAME };
