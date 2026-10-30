'use strict';

const config = require('../../config');
const { sequelize } = require('../../src/db/models');
const { sha256 } = require('../../src/utils/hash');

const TABLES = [
    'audit_logs',
    'app_usage_daily',
    'provider_state',
    'webhook_deliveries',
    'artifacts',
    'job_events',
    'job_attempts',
    'jobs',
    'sessions',
    'skills',
    'api_keys',
    'apps',
];

/** Refuse to run against anything but the local test database (rules §16). */
const assertLocalTestDb = () => {
    const url = new URL(config.get('postgres.url'));
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/cc_gateway_test') {
        throw new Error(`Integration tests must use the local cc_gateway_test DB, got ${url.hostname}${url.pathname}`);
    }
};

const truncateAll = async () => {
    // raw because: TRUNCATE ... CASCADE
    await sequelize.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
};

const jobData = (appId, overrides = {}) => ({
    appId,
    skillName: 'repo-review',
    model: 'sonnet',
    input: { repoUrl: 'x' },
    inputHash: sha256('x'),
    ...overrides,
});

module.exports = { sequelize, assertLocalTestDb, truncateAll, jobData };
