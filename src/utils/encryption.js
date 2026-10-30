'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const keyFrom = (hexKey) => {
    const key = Buffer.from(hexKey || '', 'hex');
    if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex characters).');
    return key;
};

/**
 * Encrypt a secret for storage at rest (AES-256-GCM).
 * @param {string} plaintext
 * @param {string} hexKey 64 hex characters
 * @returns {string} 'v1:<iv>:<tag>:<ciphertext>' (base64url parts)
 */
const encryptSecret = (plaintext, hexKey) => {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, keyFrom(hexKey), iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), body]
        .map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p))
        .join(':');
};

/**
 * @param {string} payload output of encryptSecret
 * @param {string} hexKey
 * @returns {string}
 * @throws {Error} on a malformed payload or a wrong key
 */
const decryptSecret = (payload, hexKey) => {
    const [version, iv, tag, body] = String(payload).split(':');
    if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Malformed encrypted secret.');
    const decipher = crypto.createDecipheriv(ALGORITHM, keyFrom(hexKey), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
};

module.exports = { encryptSecret, decryptSecret };
