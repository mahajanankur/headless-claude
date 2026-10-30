'use strict';

const { sha256, generateApiKey, safeEqualHex } = require('../../src/utils/hash');

describe('hash utils', () => {
    test('generateApiKey returns key, hash and display parts', () => {
        const k = generateApiKey('gwk');
        expect(k.key.startsWith('gwk_')).toBe(true);
        expect(k.keyHash).toBe(sha256(k.key));
        expect(k.displayPrefix).toBe(k.key.slice(0, 8));
        expect(k.last4).toBe(k.key.slice(-4));
    });

    test('keys are unique', () => {
        expect(generateApiKey('gwk').key).not.toBe(generateApiKey('gwk').key);
    });

    test('safeEqualHex compares in constant time and rejects mismatches', () => {
        const h = sha256('a');
        expect(safeEqualHex(h, sha256('a'))).toBe(true);
        expect(safeEqualHex(h, sha256('b'))).toBe(false);
        expect(safeEqualHex(h, 'abc')).toBe(false);
        expect(safeEqualHex(undefined, h)).toBe(false);
    });

    test('safeEqualHex rejects non-hex and odd-length input instead of matching or throwing', () => {
        expect(safeEqualHex('zz', 'yy')).toBe(false);
        expect(() => safeEqualHex('zz', 'ab')).not.toThrow();
        expect(safeEqualHex('zz', 'ab')).toBe(false);
        expect(safeEqualHex('abc', 'abc')).toBe(false);
    });
});
