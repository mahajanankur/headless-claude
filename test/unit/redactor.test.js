'use strict';

const { redact, redactValue, addSecret } = require('../../src/utils/redactor');

describe('redactor', () => {
    test('scrubs credential patterns', () => {
        const text =
            'token sk-ant-oat01-abcdefghijklmnop url postgres://u:p@127.0.0.1:5432/db key gwk_abcdefghijklmnopqrstuvwxyz';
        const out = redact(text);
        expect(out).not.toMatch(/sk-ant-oat01/);
        expect(out).not.toMatch(/u:p@/);
        expect(out).not.toMatch(/gwk_abc/);
    });

    test('scrubs registered secrets and env assignments', () => {
        addSecret('super-secret-value-123');
        expect(redact('x super-secret-value-123 y')).toBe('x [REDACTED] y');
        expect(redact('CLAUDE_CODE_OAUTH_TOKEN=abc123xyz')).toBe('[REDACTED]');
    });

    test('ignores short secrets and non-strings', () => {
        addSecret('short');
        expect(redact('short')).toBe('short');
        expect(redact(42)).toBe(42);
    });

    test('scrubs base64 bearer tokens', () => {
        expect(redact('Bearer abcDEF+ghiJKL/mnoPQR==')).toBe('[REDACTED]');
    });

    test('a short secret that prefixes a longer one cannot leave the longer tail visible', () => {
        addSecret('prefix-01');
        addSecret('prefix-01-and-a-much-longer-secret');
        expect(redact('x prefix-01-and-a-much-longer-secret y')).toBe('x [REDACTED] y');
    });

    test('non-plain objects pass through unchanged', () => {
        const date = new Date(0);
        expect(redactValue({ d: date }).d).toBe(date);
    });

    test('deep-redacts objects and arrays', () => {
        const out = redactValue({ a: ['Bearer abcdefghijklmnopqrstuvwxyz'], b: { c: 1 } });
        expect(out).toEqual({ a: ['[REDACTED]'], b: { c: 1 } });
    });
});
