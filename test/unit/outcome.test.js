'use strict';

const fs = require('fs');
const path = require('path');

const { classifyOutcome } = require('../../src/services/outcome.service');

const resultOf = (name) =>
    fs
        .readFileSync(path.join(__dirname, '../fixtures/claude', name), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .reverse()
        .find((e) => e.type === 'result');

const classify = (name, extra = {}) =>
    classifyOutcome({ result: resultOf(name), exit: { code: 0 }, requiresStructuredOutput: false, ...extra });

describe('classifyOutcome against recorded Claude Code output', () => {
    test.each([
        ['success.jsonl', true, null],
        ['json_schema.jsonl', true, null],
        ['max_turns.jsonl', false, 'max_turns'],
        ['bad_token.jsonl', false, 'provider_auth'],
        ['cfgdir_auth.jsonl', false, 'provider_auth'],
        ['sigint.jsonl', false, 'provider_crash'],
    ])('%s → succeeded=%s class=%s', (name, succeeded, errorClass) => {
        expect(classify(name)).toMatchObject({ succeeded, errorClass });
    });

    test('exit code 0 never implies success (SIGINT fixture exits 0)', () => {
        expect(classify('sigint.jsonl', { exit: { code: 0 } }).succeeded).toBe(false);
    });

    test('missing structured output fails when the skill requires it', () => {
        expect(classify('success.jsonl', { requiresStructuredOutput: true }).errorClass).toBe('skill_output_invalid');
        expect(classify('json_schema.jsonl', { requiresStructuredOutput: true }).succeeded).toBe(true);
    });

    test('gateway-initiated stops win over the result', () => {
        expect(classify('success.jsonl', { exit: { code: 1, reason: 'timeout' } }).errorClass).toBe('timeout');
        expect(classify('success.jsonl', { exit: { code: 1, reason: 'cancel' } }).errorClass).toBe('cancelled');
        expect(classify('success.jsonl', { exit: { code: 1, reason: 'budget' } }).errorClass).toBe('budget_exceeded');
    });

    test('no result event is a crash', () => {
        expect(classifyOutcome({ result: null, exit: { code: 137, signal: 'SIGKILL' } })).toMatchObject({
            succeeded: false,
            errorClass: 'provider_crash',
        });
    });

    test('plan-limit text is provider_limit', () => {
        const result = {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: "You've hit your session limit · resets 3pm",
        };
        expect(classifyOutcome({ result, exit: { code: 1 } }).errorClass).toBe('provider_limit');
    });
});
