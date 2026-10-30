'use strict';

/**
 * Docker runner end to end (opt-in: GW_DOCKER_TESTS=1 npm run test:integration).
 * Needs Docker and the test image:
 *   docker build -f Dockerfile.runner -t headless-claude-runner .
 *   docker build -f test/docker/Dockerfile.fake-runner -t headless-claude-runner:fake test/fixtures/fake-claude
 */
const { execFileSync } = require('child_process');

const DOCKER = process.env.GW_DOCKER_TESTS === '1';
const describeDocker = DOCKER ? describe : describe.skip;

jest.setTimeout(90000);

describeDocker('docker runner', () => {
    let config;
    let gw;
    let worker;
    let helpers;
    let notifyHub;
    let sequelize;

    beforeAll(() => {
        process.env.NODE_CONFIG = JSON.stringify({
            runner: {
                mode: 'docker',
                dockerImage: 'headless-claude-runner:fake',
                containerClaudeBin: '/opt/gateway/fake-claude',
                dockerNetwork: 'none',
            },
        });
        jest.resetModules();
        config = require('../../config');
        ({ sequelize } = require('../helpers/db'));
        helpers = require('../helpers/gateway');
        notifyHub = require('../../src/infra/notifyHub');
        expect(config.get('runner.mode')).toBe('docker');
    });

    beforeEach(async () => {
        gw = await helpers.setupGateway();
        const { Worker } = require('../../src/worker/worker');
        worker = new Worker();
        await worker.start();
    });

    afterEach(async () => worker && worker.stop());

    afterAll(async () => {
        delete process.env.NODE_CONFIG;
        await notifyHub.stop();
        await sequelize.close();
    });

    const containersFor = (jobId) =>
        execFileSync('docker', ['ps', '-a', '--filter', `label=gw.job=${jobId}`, '--format', '{{.Names}}'])
            .toString()
            .trim();

    test('runs in a locked-down container and collects the result', async () => {
        const res = await helpers.submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'write_out' } });
        const job = await helpers.waitForJob(gw.http, gw.appA, res.body.data.jobId, undefined, 60000);
        expect(job.status).toBe('succeeded');
        const result = (await gw.http.get(`/api/v1/jobs/${job.jobId}/result`).set(gw.appA.auth)).body.data;
        expect(result.output).toEqual({ summary: 'ok', findings: [] });
        expect(result.artifacts.map((a) => a.name)).toEqual(['report.md']);
        expect(containersFor(job.jobId)).toBe('');
    });

    test('cancel stops the container', async () => {
        const res = await helpers.submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'hang' } });
        const { jobId } = res.body.data;
        await helpers.waitForJob(gw.http, gw.appA, jobId, (j) => j.status === 'running', 60000);
        await helpers.sleep(1500);
        await gw.http.post(`/api/v1/jobs/${jobId}/cancel`).set(gw.appA.auth);
        expect((await helpers.waitForJob(gw.http, gw.appA, jobId, undefined, 60000)).status).toBe('cancelled');
        expect(containersFor(jobId)).toBe('');
    });

    test('a job survives a worker restart (container keeps running)', async () => {
        const res = await helpers.submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'slow' } });
        const { jobId } = res.body.data;
        await helpers.waitForJob(gw.http, gw.appA, jobId, (j) => j.status === 'running', 60000);
        await worker.stop();
        expect(containersFor(jobId)).not.toBe('');
        const { Worker } = require('../../src/worker/worker');
        worker = new Worker();
        await worker.start();
        expect((await helpers.waitForJob(gw.http, gw.appA, jobId, undefined, 60000)).status).toBe('succeeded');
    });
});
