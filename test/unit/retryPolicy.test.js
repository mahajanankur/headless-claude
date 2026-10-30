'use strict';

const { decideAfterFailure } = require('../../src/services/retryPolicy.service');

const base = {
    errorClass: 'provider_crash',
    startedActing: false,
    actedOutsideWorkspace: false,
    canResume: false,
    rerunSafe: false,
    autoRetriesUsed: 0,
    maxAutoRetries: 2,
};
const decide = (over) => decideAfterFailure({ ...base, ...over });

describe('retry ladder (decision D18)', () => {
    test('nothing acted → fresh retry, counted', () => {
        expect(decide({})).toEqual({ action: 'retry', mode: 'fresh', counted: true });
    });

    test('acted and resumable → resume', () => {
        expect(decide({ startedActing: true, canResume: true })).toMatchObject({ action: 'retry', mode: 'resume' });
    });

    test('acted inside the workspace only → fresh', () => {
        expect(decide({ startedActing: true })).toMatchObject({ action: 'retry', mode: 'fresh' });
    });

    test('acted outside, not resumable, not rerunSafe → needs_review', () => {
        expect(decide({ startedActing: true, actedOutsideWorkspace: true })).toEqual({
            action: 'finish',
            status: 'needs_review',
        });
    });

    test('rerunSafe allows a fresh retry after outside effects', () => {
        expect(decide({ startedActing: true, actedOutsideWorkspace: true, rerunSafe: true })).toMatchObject({
            mode: 'fresh',
        });
    });

    test('retries exhausted → failed, or needs_review when outside effects', () => {
        expect(decide({ autoRetriesUsed: 2 })).toEqual({ action: 'finish', status: 'failed' });
        expect(
            decide({ autoRetriesUsed: 2, startedActing: true, actedOutsideWorkspace: true, canResume: true }),
        ).toEqual({
            action: 'finish',
            status: 'needs_review',
        });
    });

    test('timeouts finish as timed_out', () => {
        expect(decide({ errorClass: 'timeout', autoRetriesUsed: 2 })).toEqual({
            action: 'finish',
            status: 'timed_out',
        });
    });

    test('auth/gateway failures before acting retry without counting', () => {
        expect(decide({ errorClass: 'provider_auth', autoRetriesUsed: 9 })).toEqual({
            action: 'retry',
            mode: 'fresh',
            counted: false,
        });
    });

    test('uncounted infra retries are bounded', () => {
        expect(decide({ errorClass: 'gateway', attemptsMade: 9 })).toEqual({ action: 'finish', status: 'failed' });
        expect(decide({ errorClass: 'gateway', attemptsMade: 8 }).action).toBe('retry');
    });

    test('limit hits wait (uncounted), or need review when no safe retry exists', () => {
        expect(decide({ errorClass: 'provider_limit', startedActing: true, canResume: true })).toEqual({
            action: 'wait_limit',
            mode: 'resume',
            counted: false,
        });
        expect(decide({ errorClass: 'provider_limit', startedActing: true, actedOutsideWorkspace: true })).toEqual({
            action: 'finish',
            status: 'needs_review',
        });
    });

    test.each(['skill_output_invalid', 'max_turns', 'budget_exceeded'])('%s never retries', (errorClass) => {
        expect(decide({ errorClass })).toEqual({ action: 'finish', status: 'failed' });
    });

    test('cancel wins and flags partial work', () => {
        expect(decide({ cancelRequested: true, startedActing: true })).toEqual({
            action: 'finish',
            status: 'cancelled',
            possiblyPartial: true,
        });
    });
});
