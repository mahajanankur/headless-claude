'use strict';

const {
    JOB_STATUS,
    TERMINAL_STATUSES,
    TRANSITIONS,
    isTerminal,
    canTransition,
    sourcesOf,
} = require('../../src/constants/jobStatus');

describe('job state machine', () => {
    test('terminal states have no outgoing transitions', () => {
        TERMINAL_STATUSES.forEach((s) => expect(TRANSITIONS[s]).toBeUndefined());
    });

    test('happy path is allowed', () => {
        expect(canTransition(JOB_STATUS.QUEUED, JOB_STATUS.CLAIMED)).toBe(true);
        expect(canTransition(JOB_STATUS.CLAIMED, JOB_STATUS.PROVISIONING)).toBe(true);
        expect(canTransition(JOB_STATUS.PROVISIONING, JOB_STATUS.RUNNING)).toBe(true);
        expect(canTransition(JOB_STATUS.RUNNING, JOB_STATUS.SUCCEEDED)).toBe(true);
    });

    test('limit pause and cancel paths', () => {
        expect(canTransition(JOB_STATUS.RUNNING, JOB_STATUS.WAITING_LIMIT)).toBe(true);
        expect(canTransition(JOB_STATUS.WAITING_LIMIT, JOB_STATUS.QUEUED)).toBe(true);
        expect(canTransition(JOB_STATUS.RUNNING, JOB_STATUS.CANCELLING)).toBe(true);
        expect(canTransition(JOB_STATUS.CANCELLING, JOB_STATUS.CANCELLED)).toBe(true);
    });

    test('illegal transitions are rejected', () => {
        expect(canTransition(JOB_STATUS.SUCCEEDED, JOB_STATUS.QUEUED)).toBe(false);
        expect(canTransition(JOB_STATUS.QUEUED, JOB_STATUS.SUCCEEDED)).toBe(false);
        expect(canTransition(JOB_STATUS.CANCELLING, JOB_STATUS.SUCCEEDED)).toBe(false);
    });

    test('isTerminal and sourcesOf', () => {
        expect(isTerminal(JOB_STATUS.NEEDS_REVIEW)).toBe(true);
        expect(isTerminal(JOB_STATUS.RUNNING)).toBe(false);
        expect(sourcesOf(JOB_STATUS.CANCELLED).sort()).toEqual(
            [JOB_STATUS.CANCELLING, JOB_STATUS.QUEUED, JOB_STATUS.WAITING_LIMIT].sort(),
        );
    });

    test('constants are frozen', () => {
        expect(Object.isFrozen(JOB_STATUS)).toBe(true);
        expect(Object.isFrozen(TRANSITIONS[JOB_STATUS.QUEUED])).toBe(true);
    });
});
