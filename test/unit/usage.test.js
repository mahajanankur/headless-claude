'use strict';

const fs = require('fs');
const path = require('path');

const usage = require('../../src/services/usage.service');

const fixture = (name) =>
    fs
        .readFileSync(path.join(__dirname, '../fixtures/claude', name), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));

describe('usage.service', () => {
    test('weightedTokens discounts cache reads', () => {
        const u = {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
        };
        expect(usage.weightedTokens(u, 0.1)).toBe(230);
        expect(usage.weightedTokens(null, 0.1)).toBe(0);
    });

    test('parses the recorded rate_limit_event', () => {
        const event = fixture('success.jsonl').find((e) => e.type === 'rate_limit_event');
        const parsed = usage.parseRateLimitInfo(event.rate_limit_info);
        expect(parsed.status).toBe('allowed');
        expect(parsed.windows.five_hour.utilization).toBeGreaterThan(0);
        expect(parsed.windows.five_hour.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(usage.peakUtilization(parsed).utilization).toBe(
            Math.max(parsed.windows.five_hour.utilization, parsed.windows.seven_day.utilization),
        );
    });

    test.each([
        ['five_hour', 'global'],
        ['seven_day', 'global'],
        ['seven_day_opus', 'model:opus'],
        [null, 'global'],
    ])('limitScopeFor(%s) → %s', (type, scope) => expect(usage.limitScopeFor(type)).toBe(scope));

    test.each([
        ["You've hit your session limit · resets 3:45pm", 'global'],
        ["You've hit your weekly limit", 'global'],
        ["You've hit your Opus limit · resets Mon", 'model:opus'],
    ])('detectLimitMessage(%s)', (text, scope) => expect(usage.detectLimitMessage(text)).toEqual({ scope }));

    test('detectLimitMessage ignores unrelated text', () => expect(usage.detectLimitMessage('all good')).toBeNull());

    test('budgetDay and nextBudgetReset use the app time zone', () => {
        const d = new Date('2026-10-28T20:00:00Z'); // 01:30 next day in Kolkata
        expect(usage.budgetDay(d, 'UTC')).toBe('2026-10-28');
        expect(usage.budgetDay(d, 'Asia/Kolkata')).toBe('2026-10-29');
        const reset = usage.nextBudgetReset(d, 'UTC');
        expect(usage.budgetDay(reset, 'UTC')).toBe('2026-10-29');
        expect(reset.getTime() - new Date('2026-10-29T00:00:00Z').getTime()).toBeLessThan(15 * 60000);
    });
});
