'use strict';

const MINUTES_PER_DAY = 24 * 60;

const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

/**
 * Minutes since local midnight in an IANA time zone.
 * @param {Date} date
 * @param {string} timeZone e.g. 'Asia/Kolkata'
 * @returns {number}
 */
const localMinutes = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return get('hour') * 60 + get('minute');
};

/**
 * Is `date` inside one window? Windows may cross midnight (22:00-07:00). from === to means all day.
 * @param {Date} date
 * @param {{tz: string, from: string, to: string}} window
 * @returns {boolean}
 */
const isInWindow = (date, { tz, from, to }) => {
    const now = localMinutes(date, tz);
    const start = toMinutes(from);
    const end = toMinutes(to);
    if (start === end) return true;
    return start < end ? now >= start && now < end : now >= start || now < end;
};

/**
 * A window list allows `date` when it is empty/absent or any window contains it.
 * @param {Date} date
 * @param {Array|null|undefined} windows
 * @returns {boolean}
 */
const isAllowedByWindows = (date, windows) =>
    !windows || windows.length === 0 || windows.some((w) => isInWindow(date, w));

/**
 * Next time (minute resolution, within 48h) at which both window lists allow a start; null if never.
 * @param {Date} from
 * @param {Array|null} windowsA
 * @param {Array|null} windowsB
 * @returns {Date|null}
 */
const nextAllowedTime = (from, windowsA, windowsB) => {
    const start = new Date(Math.ceil(from.getTime() / 60000) * 60000);
    for (let i = 0; i <= 2 * MINUTES_PER_DAY; i += 1) {
        const candidate = new Date(start.getTime() + i * 60000);
        if (isAllowedByWindows(candidate, windowsA) && isAllowedByWindows(candidate, windowsB)) return candidate;
    }
    return null;
};

module.exports = { isInWindow, isAllowedByWindows, nextAllowedTime, localMinutes };
