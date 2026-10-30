'use strict';

const { sequelize, assertLocalTestDb, truncateAll, jobData } = require('../helpers/db');
const appRepository = require('../../src/repositories/app.repository');
const jobRepository = require('../../src/repositories/job.repository');
const jobEventRepository = require('../../src/repositories/jobEvent.repository');
const { withTransaction } = require('../../src/utils/transaction');
const { JOB_STATUS } = require('../../src/constants/jobStatus');

let appA;
let appB;

beforeAll(() => assertLocalTestDb());

beforeEach(async () => {
    await truncateAll();
    appA = await appRepository.create({ name: 'app-a', allowedSkills: ['repo-review'] });
    appB = await appRepository.create({ name: 'app-b', allowedSkills: ['repo-review'] });
});

afterAll(() => sequelize.close());

describe('app isolation', () => {
    test('app B cannot read app A job (null → 404)', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        expect(await jobRepository.findByIdForApp(job.id, appA.id)).toMatchObject({ id: job.id });
        expect(await jobRepository.findByIdForApp(job.id, appB.id)).toBeNull();
    });

    test('app-facing methods refuse a missing appId', async () => {
        await expect(jobRepository.findByIdForApp('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
            'appId is required',
        );
        await expect(jobRepository.create(jobData(undefined))).rejects.toThrow('appId is required');
    });

    test('app B cannot update app A job through an app-scoped guarded update', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        const n = await jobRepository.updateGuarded(
            job.id,
            [JOB_STATUS.QUEUED],
            { status: JOB_STATUS.CANCELLED },
            {
                appId: appB.id,
            },
        );
        expect(n).toBe(0);
        expect((await jobRepository.findByIdInternal(job.id)).status).toBe(JOB_STATUS.QUEUED);
    });

    test('job-level events (no attempt) are deduplicated on replay', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        const row = { jobId: job.id, appId: appA.id, attemptId: null, seq: 1, type: 'status', summary: 'queued' };
        await jobEventRepository.bulkInsert([row]);
        await jobEventRepository.bulkInsert([row]);
        expect(await jobEventRepository.listForJob(job.id, appA.id, { afterId: null, limit: 10 })).toHaveLength(1);
    });

    test('events are app-scoped', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        await jobEventRepository.bulkInsert([
            { jobId: job.id, appId: appA.id, seq: 1, type: 'status', summary: 'queued' },
        ]);
        expect(await jobEventRepository.listForJob(job.id, appA.id, { limit: 10 })).toHaveLength(1);
        expect(await jobEventRepository.listForJob(job.id, appB.id, { limit: 10 })).toHaveLength(0);
    });
});

describe('idempotency', () => {
    test('same app + key is rejected by the unique index; other app may reuse it', async () => {
        await jobRepository.create(jobData(appA.id, { idempotencyKey: 'k1' }));
        await expect(jobRepository.create(jobData(appA.id, { idempotencyKey: 'k1' }))).rejects.toThrow();
        await expect(jobRepository.create(jobData(appB.id, { idempotencyKey: 'k1' }))).resolves.toBeTruthy();
    });
});

describe('claiming', () => {
    test('two concurrent claimers never lock the same job (SKIP LOCKED)', async () => {
        await Promise.all([1, 2, 3, 4].map(() => jobRepository.create(jobData(appA.id))));
        const t1 = await sequelize.transaction();
        const t2 = await sequelize.transaction();
        try {
            const first = await jobRepository.lockClaimCandidatesInternal({ limit: 2 }, { transaction: t1 });
            const second = await jobRepository.lockClaimCandidatesInternal({ limit: 10 }, { transaction: t2 });
            const overlap = first.filter((j) => second.some((k) => k.id === j.id));
            expect(first).toHaveLength(2);
            expect(second).toHaveLength(2);
            expect(overlap).toHaveLength(0);
        } finally {
            await t1.rollback();
            await t2.rollback();
        }
    });

    test('run_after in the future is not claimable', async () => {
        await jobRepository.create(jobData(appA.id, { runAfter: new Date(Date.now() + 3600e3) }));
        const t = await sequelize.transaction();
        try {
            expect(await jobRepository.lockClaimCandidatesInternal({ limit: 5 }, { transaction: t })).toHaveLength(0);
        } finally {
            await t.rollback();
        }
    });

    test('guarded update affects 0 rows when the status moved on', async () => {
        const job = await jobRepository.create(jobData(appA.id));
        expect(await jobRepository.updateGuarded(job.id, [JOB_STATUS.QUEUED], { status: JOB_STATUS.CLAIMED })).toBe(1);
        expect(await jobRepository.updateGuarded(job.id, [JOB_STATUS.QUEUED], { status: JOB_STATUS.CLAIMED })).toBe(0);
    });
});

describe('withTransaction', () => {
    test('rolls back every write when work throws', async () => {
        await expect(
            withTransaction('test.rollback', async (transaction) => {
                await jobRepository.create(jobData(appA.id), { transaction });
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(await jobRepository.listForApp(appA.id, { limit: 10 })).toHaveLength(0);
    });

    test('commits and returns the result', async () => {
        const id = await withTransaction('test.commit', async (transaction) => {
            const job = await jobRepository.create(jobData(appA.id), { transaction });
            return job.id;
        });
        expect(await jobRepository.findByIdForApp(id, appA.id)).toMatchObject({ id });
    });
});
