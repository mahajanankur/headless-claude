'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const config = require('../../config');
const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { AdvisoryLock } = require('../../src/infra/advisoryLock');
const { getSecrets, resetSecretsCache } = require('../../src/infra/secrets');

const ROOT = path.resolve(__dirname, '../..');

beforeAll(() => assertLocalTestDb());
afterAll(() => sequelize.close());

describe('AdvisoryLock', () => {
    test('only one holder at a time; released on release()', async () => {
        const a = new AdvisoryLock(991001);
        const b = new AdvisoryLock(991001);
        expect(await a.tryAcquire()).toBe(true);
        expect(await b.tryAcquire()).toBe(false);
        await a.release();
        expect(await b.tryAcquire()).toBe(true);
        await b.release();
    });

    test('a failed connect is not cached: later attempts reconnect instead of using a dead client', async () => {
        const lock = new AdvisoryLock(991002, { connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none' });
        await expect(lock.tryAcquire()).rejects.toThrow(/ECONNREFUSED|connect/);
        expect(lock.client).toBeNull();
        await expect(lock.tryAcquire()).rejects.toThrow(/ECONNREFUSED|connect/);
    });
});

describe('secrets', () => {
    test('configured values win over the file and every value is registered for redaction', () => {
        resetSecretsCache();
        const secrets = getSecrets();
        expect(secrets.claudeOauthToken).toBe(config.get('secrets.claudeOauthToken'));
        const { redact } = require('../../src/utils/redactor');
        expect(redact(`token ${secrets.claudeOauthToken} here`)).toBe('token [REDACTED] here');
    });
});

describe('config loader', () => {
    test('an unknown NODE_ENV fails fast instead of running with development settings', () => {
        expect(() =>
            execFileSync(process.execPath, ['-e', "require('./config')"], {
                cwd: ROOT,
                env: { ...process.env, NODE_ENV: 'prod' },
                stdio: 'pipe',
            }),
        ).toThrow(/NODE_ENV must be one of development, test, production/);
    });

    test('NODE_ENV unset falls back to development, which never selects the local runner by itself', () => {
        const out = execFileSync(
            process.execPath,
            ['-e', "process.stdout.write(require('./config').get('runner.mode'))"],
            {
                cwd: ROOT,
                env: { PATH: process.env.PATH, HOME: process.env.HOME },
                stdio: 'pipe',
            },
        ).toString();
        expect(['docker', 'local']).toContain(out); // 'local' only when .env.local opts in
        expect(require('../../config/development.json').runner).toBeUndefined();
    });
});
