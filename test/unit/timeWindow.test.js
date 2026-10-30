'use strict';

const { isInWindow, isAllowedByWindows, nextAllowedTime } = require('../../src/utils/timeWindow');

const at = (iso) => new Date(iso);
const night = { tz: 'UTC', from: '22:00', to: '07:00' };

describe('timeWindow', () => {
    test.each([
        ['2026-10-28T23:30:00Z', true],
        ['2026-10-28T03:00:00Z', true],
        ['2026-10-28T07:00:00Z', false],
        ['2026-10-28T12:00:00Z', false],
        ['2026-10-28T22:00:00Z', true],
    ])('window crossing midnight at %s → %s', (iso, expected) => {
        expect(isInWindow(at(iso), night)).toBe(expected);
    });

    test('respects the time zone', () => {
        // 17:00Z is 22:30 in Asia/Kolkata (+05:30)
        expect(isInWindow(at('2026-10-28T17:00:00Z'), { tz: 'Asia/Kolkata', from: '22:00', to: '07:00' })).toBe(true);
        expect(isInWindow(at('2026-10-28T17:00:00Z'), night)).toBe(false);
    });

    test('handles a DST change (America/New_York, 2026-11-01)', () => {
        const win = { tz: 'America/New_York', from: '01:00', to: '03:00' };
        expect(isInWindow(at('2026-11-01T05:30:00Z'), win)).toBe(true); // 01:30 EDT
        expect(isInWindow(at('2026-11-01T06:30:00Z'), win)).toBe(true); // 01:30 EST
        expect(isInWindow(at('2026-11-01T08:30:00Z'), win)).toBe(false); // 03:30 EST
    });

    test('from === to means all day; empty lists allow everything', () => {
        expect(isInWindow(at('2026-10-28T12:00:00Z'), { tz: 'UTC', from: '00:00', to: '00:00' })).toBe(true);
        expect(isAllowedByWindows(at('2026-10-28T12:00:00Z'), null)).toBe(true);
        expect(isAllowedByWindows(at('2026-10-28T12:00:00Z'), [])).toBe(true);
    });

    test('nextAllowedTime finds the start of the intersection', () => {
        const next = nextAllowedTime(at('2026-10-28T12:00:00Z'), [night], [{ tz: 'UTC', from: '23:00', to: '23:30' }]);
        expect(next.toISOString()).toBe('2026-10-28T23:00:00.000Z');
        expect(
            nextAllowedTime(
                at('2026-10-28T12:00:00Z'),
                [{ tz: 'UTC', from: '01:00', to: '02:00' }],
                [{ tz: 'UTC', from: '03:00', to: '04:00' }],
            ),
        ).toBeNull();
    });
});
