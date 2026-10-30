'use strict';

const PATTERNS = Object.freeze([
    /sk-ant-[A-Za-z0-9_-]{10,}/g,
    /gwk_[A-Za-z0-9_-]{20,}/g,
    /postgres(?:ql)?:\/\/[^\s"'@]+@[^\s"']+/g,
    /(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=\S+/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
]);

const MIN_SECRET_LENGTH = 8;
const extraSecrets = new Set();
let secretsLongestFirst = [];

/**
 * Register a concrete secret value (token, manifest secret) so it is scrubbed everywhere.
 * @param {string} value
 * @returns {void}
 */
const addSecret = (value) => {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH || extraSecrets.has(value)) return;
    extraSecrets.add(value);
    // longest first, so a secret that prefixes another can't leave the longer one's tail visible
    secretsLongestFirst = [...extraSecrets].sort((x, y) => y.length - x.length);
};

/**
 * Remove secrets and credential patterns from a string.
 * @param {string} text
 * @returns {string}
 */
const redact = (text) => {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    secretsLongestFirst.forEach((secret) => {
        out = out.split(secret).join('[REDACTED]');
    });
    return PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), out);
};

/**
 * Deep-redact strings inside plain objects and arrays. Other values (Date, Buffer, ...) pass through.
 * @param {*} value
 * @returns {*}
 */
const redactValue = (value) => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]));
    }
    return value;
};

module.exports = { redact, redactValue, addSecret };
