'use strict';

const crypto = require('crypto');

/**
 * SHA-256 hex digest.
 * @param {string|Buffer} value
 * @returns {string}
 */
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Generate a new API key. The plaintext is shown once; only the hash is stored.
 * @param {string} prefix e.g. 'gwk'
 * @returns {{key: string, keyHash: string, displayPrefix: string, last4: string}}
 */
const generateApiKey = (prefix) => {
    const secret = crypto.randomBytes(32).toString('base64url');
    const key = `${prefix}_${secret}`;
    return { key, keyHash: sha256(key), displayPrefix: key.slice(0, prefix.length + 5), last4: key.slice(-4) };
};

const HEX = /^(?:[0-9a-f]{2})+$/i;

/**
 * Constant-time comparison of two hex digests. Non-hex or odd-length input never matches.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const safeEqualHex = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    if (!HEX.test(a) || !HEX.test(b)) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

/**
 * JSON with object keys sorted, so equal values always produce equal strings (idempotency hashing).
 * @param {*} value
 * @returns {string}
 */
const stableStringify = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .filter((k) => value[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
};

module.exports = { sha256, generateApiKey, safeEqualHex, stableStringify };
