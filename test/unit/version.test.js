'use strict';

const { compareVersions } = require('../../src/utils/version');

describe('compareVersions', () => {
    test.each([
        ['2.0.0', '1.4.1', 1],
        ['1.4.1', '2.0.0', -1],
        ['10.0.0', '9.9.9', 1],
        ['1.10.0', '1.9.0', 1],
        ['1.0.0', '1.0.0', 0],
    ])('%s vs %s', (a, b, sign) => {
        expect(Math.sign(compareVersions(a, b))).toBe(sign);
    });
});
