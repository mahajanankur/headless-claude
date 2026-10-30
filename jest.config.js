'use strict';

module.exports = {
    projects: [
        { displayName: 'unit', testEnvironment: 'node', testMatch: ['<rootDir>/test/unit/**/*.test.js'] },
        {
            displayName: 'integration',
            testEnvironment: 'node',
            testMatch: ['<rootDir>/test/integration/**/*.test.js'],
        },
    ],
};
