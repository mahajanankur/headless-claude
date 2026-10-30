'use strict';

const { sequelize, assertLocalTestDb, truncateAll, jobData } = require('../helpers/db');
const appRepository = require('../../src/repositories/app.repository');
const apiKeyRepository = require('../../src/repositories/apiKey.repository');
const jobRepository = require('../../src/repositories/job.repository');
const jobAttemptRepository = require('../../src/repositories/jobAttempt.repository');
const artifactRepository = require('../../src/repositories/artifact.repository');
const appUsageDailyRepository = require('../../src/repositories/appUsageDaily.repository');
const providerStateRepository = require('../../src/repositories/providerState.repository');
const auditLogRepository = require('../../src/repositories/auditLog.repository');
const { AuditLog } = require('../../src/db/models');
const { generateApiKey } = require('../../src/utils/hash');
const { JOB_STATUS } = require('../../src/constants/jobStatus');

let appA;
let appB;

const attemptData = (job, overrides = {}) => ({
    jobId: job.id,
    appId: job.appId,
    n: 1,
    skillVersion: '1.0.0',
    skillChecksum: 'c'.repeat(64),
    manifest: { name: 'repo-review' },
    model: 'sonnet',
    runtime: 'local',
    hostId: 'host-1',
    ...overrides,
});

beforeAll(() => assertLocalTestDb());

beforeEach(async () => {
    await truncateAll();
    appA = await appRepository.create({ name: 'app-a', allowedSkills: ['repo-review'] });
    appB = await appRepository.create({ name: 'app-b' });
});

afterAll(() => sequelize.close());

describe('app and api key repositories', () => {
    test('findByIdInternal ignores inactive apps', async () => {
        expect(await appRepository.findByIdInternal(appA.id)).toMatchObject({ name: 'app-a' });
        const inactive = await appRepository.create({ name: 'gone', active: false });
        expect(await appRepository.findByIdInternal(inactive.id)).toBeNull();
    });

    test('findActiveByHash excludes revoked and expired keys', async () => {
        const make = async (overrides) => {
            const k = generateApiKey('gwk');
            const data = { appId: appA.id, keyHash: k.keyHash, displayPrefix: k.displayPrefix, last4: k.last4 };
            await apiKeyRepository.create({ ...data, ...overrides });
            return k.keyHash;
        };
        const live = await make({});
        const revoked = await make({ revokedAt: new Date() });
        const expired = await make({ expiresAt: new Date(Date.now() - 1000) });
        expect(await apiKeyRepository.findActiveByHash(live)).toMatchObject({ appId: appA.id });
        expect(await apiKeyRepository.findActiveByHash(revoked)).toBeNull();
        expect(await apiKeyRepository.findActiveByHash(expired)).toBeNull();
    });
});

describe('job listing and leases', () => {
    test('listForApp paginates newest first with a stable cursor', async () => {
        for (let i = 0; i < 3; i += 1) await jobRepository.create(jobData(appA.id));
        await jobRepository.create(jobData(appB.id));
        const page1 = await jobRepository.listForApp(appA.id, { limit: 2 });
        const last = page1[page1.length - 1];
        const page2 = await jobRepository.listForApp(appA.id, {
            limit: 2,
            before: { createdAt: last.createdAt, id: last.id },
        });
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(1);
        expect(new Set([...page1, ...page2].map((j) => j.id)).size).toBe(3);
    });

    test('active counts, host lookup, lease renewal and expiry', async () => {
        const job = await jobRepository.create(jobData(appA.id, { skillClass: 'long' }));
        const past = new Date(Date.now() - 1000);
        await jobRepository.updateGuarded(job.id, [JOB_STATUS.QUEUED], {
            status: JOB_STATUS.RUNNING,
            leaseOwner: 'host-1',
            leaseExpiresAt: past,
        });
        expect(await jobRepository.countActiveInternal()).toEqual({
            byClass: { long: 1 },
            byApp: { [appA.id]: 1 },
            total: 1,
        });
        expect(await jobRepository.findActiveByHostInternal('host-1')).toHaveLength(1);
        expect(await jobRepository.findExpiredLeasesInternal(new Date())).toHaveLength(1);
        expect(await jobRepository.renewLeasesInternal([job.id], 'other-host', new Date(Date.now() + 60e3))).toBe(0);
        expect(await jobRepository.renewLeasesInternal([job.id], 'host-1', new Date(Date.now() + 60e3))).toBe(1);
        expect(await jobRepository.findExpiredLeasesInternal(new Date())).toHaveLength(0);
        expect(await jobRepository.renewLeasesInternal([], 'host-1', new Date())).toBe(0);
    });
});

describe('attempts and artifacts', () => {
    test('attempt lifecycle and app-scoped history', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        const attempt = await jobAttemptRepository.create(attemptData(job));
        expect(await jobAttemptRepository.findOpenForJobsInternal([job.id])).toHaveLength(1);
        await jobAttemptRepository.update(attempt.id, { finishedAt: new Date(), subtype: 'success' });
        expect(await jobAttemptRepository.findOpenForJobsInternal([job.id])).toHaveLength(0);
        expect((await jobAttemptRepository.findLatestForJobInternal(job.id)).id).toBe(attempt.id);
        expect(await jobAttemptRepository.listForJob(job.id, appA.id)).toHaveLength(1);
        expect(await jobAttemptRepository.listForJob(job.id, appB.id)).toHaveLength(0);
    });

    test('artifacts are app-scoped and never list the disk path', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        await artifactRepository.bulkCreate([
            { jobId: job.id, appId: appA.id, name: 'report.md', path: '/x/report.md', size: 3, sha256: 'a'.repeat(64) },
        ]);
        const [listed] = await artifactRepository.listForJob(job.id, appA.id);
        expect(listed.path).toBeUndefined();
        expect((await artifactRepository.findByIdForApp(listed.id, appA.id)).path).toBe('/x/report.md');
        expect(await artifactRepository.findByIdForApp(listed.id, appB.id)).toBeNull();
    });
});

describe('usage, provider state and audit', () => {
    test('addTokens accumulates per app and day', async () => {
        await appUsageDailyRepository.addTokens(appA.id, '2026-10-28', 100);
        await appUsageDailyRepository.addTokens(appA.id, '2026-10-28', 50);
        expect(await appUsageDailyRepository.getTokens(appA.id, '2026-10-28')).toBe(150);
        expect(await appUsageDailyRepository.getTokens(appB.id, '2026-10-28')).toBe(0);
    });

    test('provider state set/get overwrites', async () => {
        expect(await providerStateRepository.get('usage')).toBeNull();
        await providerStateRepository.set('usage', { fiveHour: 0.2 });
        await providerStateRepository.set('usage', { fiveHour: 0.3 });
        expect(await providerStateRepository.get('usage')).toEqual({ fiveHour: 0.3 });
    });

    test('audit entries are written', async () => {
        await auditLogRepository.create({
            appId: appA.id,
            action: 'key.created',
            targetType: 'api_key',
            targetId: 'k1',
        });
        expect(await AuditLog.count({ where: { appId: appA.id, action: 'key.created' } })).toBe(1);
    });
});
