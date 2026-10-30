'use strict';

const { canStart } = require('../../src/services/schedulingPolicy.service');

const now = new Date('2026-10-28T12:00:00Z');
const ctx = (over = {}) => ({
    job: { skillClass: 'quick', model: 'sonnet', urgent: false, ...over.job },
    app: {
        id: 'a',
        maxConcurrent: 2,
        dailyTokenBudget: null,
        timezone: 'UTC',
        runWindows: null,
        intakePaused: false,
        ...over.app,
    },
    manifest: { runWindows: null, ...over.manifest },
    active: { total: 0, byClass: {}, byApp: {}, ...over.active },
    limits: { concurrency: 2, longSlots: 1, ...over.limits },
    pauses: over.pauses || {},
    usage: over.usage || null,
    thresholds: { quick: 0.9, long: 0.7 },
    budget: { used: 0, ...over.budget },
    now,
});
const night = [{ tz: 'UTC', from: '22:00', to: '07:00' }];
const usageAt = (u) => ({ windows: { five_hour: { utilization: u, resetsAt: '2026-10-28T15:00:00.000Z' } } });

describe('schedulingPolicy.canStart', () => {
    test('allows when nothing blocks', () => expect(canStart(ctx())).toEqual({ ok: true }));

    test.each([
        ['global slots full', { active: { total: 2 } }, 'no_slot'],
        [
            'long slot taken',
            { job: { skillClass: 'long' }, active: { total: 1, byClass: { long: 1 } } },
            'no_long_slot',
        ],
        [
            'app at its concurrency',
            { app: { maxConcurrent: 1 }, active: { total: 1, byApp: { a: 1 } } },
            'app_concurrency',
        ],
        ['global pause', { pauses: { global: '2026-10-28T13:00:00Z' } }, 'paused'],
        [
            'model pause',
            { job: { model: 'claude-opus-5-5' }, pauses: { 'model:opus': '2026-10-28T13:00:00Z' } },
            'paused',
        ],
        ['long job above long threshold', { job: { skillClass: 'long' }, usage: usageAt(0.75) }, 'usage_threshold'],
        ['budget used up', { app: { dailyTokenBudget: 100 }, budget: { used: 100 } }, 'budget'],
        ['outside the app window', { app: { runWindows: night } }, 'window'],
        ['outside the skill window', { manifest: { runWindows: night } }, 'window'],
        ['intake paused', { app: { intakePaused: true } }, 'intake_paused'],
    ])('blocks: %s', (_label, over, reason) => {
        expect(canStart(ctx(over))).toMatchObject({ ok: false, reason });
    });

    test('an expired pause and another model’s pause do not block', () => {
        expect(
            canStart(ctx({ pauses: { global: '2026-10-28T11:00:00Z', 'model:opus': '2026-10-28T13:00:00Z' } })).ok,
        ).toBe(true);
    });

    test('quick jobs still run between the long and quick thresholds', () => {
        expect(canStart(ctx({ usage: usageAt(0.75) })).ok).toBe(true);
        expect(canStart(ctx({ usage: usageAt(0.95) })).reason).toBe('usage_threshold');
    });

    test('urgent skips only the run window', () => {
        expect(canStart(ctx({ job: { urgent: true }, app: { runWindows: night } })).ok).toBe(true);
        expect(canStart(ctx({ job: { urgent: true }, pauses: { global: '2026-10-28T13:00:00Z' } })).reason).toBe(
            'paused',
        );
        expect(canStart(ctx({ job: { urgent: true }, app: { dailyTokenBudget: 1 }, budget: { used: 1 } })).reason).toBe(
            'budget',
        );
    });

    test('window and pause blocks carry retryAt', () => {
        expect(canStart(ctx({ app: { runWindows: night } })).retryAt.toISOString()).toBe('2026-10-28T22:00:00.000Z');
        expect(canStart(ctx({ pauses: { global: '2026-10-28T13:00:00Z' } })).retryAt.toISOString()).toBe(
            '2026-10-28T13:00:00.000Z',
        );
    });
});
