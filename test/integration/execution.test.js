'use strict';

const fs = require('fs');
const path = require('path');

const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { setupGateway, startWorker, waitForJob, submit, sleep } = require('../helpers/gateway');
const notifyHub = require('../../src/infra/notifyHub');
const { Worker } = require('../../src/worker/worker');
const { JobAttempt, ProviderState } = require('../../src/db/models');

jest.setTimeout(60000);

let gw;
let worker;

const run = async (body, app = gw.appA) => {
    const res = await submit(gw.http, app, body);
    expect(res.status).toBe(202);
    return res.body.data.jobId;
};

const attemptsOf = (jobId) => JobAttempt.findAll({ where: { jobId }, order: [['n', 'ASC']], raw: true });

beforeAll(() => assertLocalTestDb());
beforeEach(async () => {
    gw = await setupGateway();
    worker = await startWorker();
});
afterEach(async () => {
    if (worker) await worker.stop();
    worker = null;
});
afterAll(async () => {
    await notifyHub.stop();
    await sequelize.close();
});

describe('successful runs', () => {
    test('structured output, events, artifacts and download', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'write_out' } });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('succeeded');
        expect(job.attempts).toHaveLength(1);
        expect(job.attempts[0]).toMatchObject({ mode: 'fresh', subtype: 'success', skillVersion: '1.0.0' });

        const result = (await gw.http.get(`/api/v1/jobs/${jobId}/result`).set(gw.appA.auth)).body.data;
        expect(result.output).toEqual({ summary: 'ok', findings: [] });
        expect(result.artifacts.map((a) => a.name)).toEqual(['report.md']);
        const file = await gw.http.get(`/api/v1/artifacts/${result.artifacts[0].id}`).set(gw.appA.auth);
        expect(file.status).toBe(200);
        expect(file.text).toContain('All good.');
        expect((await gw.http.get(`/api/v1/artifacts/${result.artifacts[0].id}`).set(gw.appB.auth)).status).toBe(404);

        const events = (await gw.http.get(`/api/v1/jobs/${jobId}/events?limit=200`).set(gw.appA.auth)).body.data.items;
        const types = events.map((e) => e.type);
        expect(types).toEqual(expect.arrayContaining(['status', 'init', 'tool_use', 'tool_result', 'result']));
        expect(events.find((e) => e.type === 'tool_use').summary).toBe('Write');
    });

    test('the Claude process gets a minimal environment and the hardened arguments', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'success' } });
        await waitForJob(gw.http, gw.appA, jobId);
        const [attempt] = await attemptsOf(jobId);
        // successful non-session jobs clean their workspace; read the recorded argv from a kept failure instead
        expect(attempt.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
        const failedId = await run({ skill: 'fake-skill', input: { scenario: 'no_output', marker: 1 } });
        await waitForJob(gw.http, gw.appA, failedId);
        const [failed] = await attemptsOf(failedId);
        const [record] = JSON.parse(fs.readFileSync(path.join(failed.workspacePath, 'fake-argv.json'), 'utf8'));
        const { argv, env } = record;
        expect(argv).toEqual(
            expect.arrayContaining(['--output-format', 'stream-json', '--setting-sources', 'user', '--model', 'haiku']),
        );
        expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
        expect(argv[argv.indexOf('--disallowedTools') + 1]).toContain('AskUserQuestion');
        expect(argv).toContain('--json-schema');
        expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Edit,Write,NotebookEdit,StructuredOutput');
        expect(argv).toContain('--disable-slash-commands');
        expect(argv[argv.indexOf('--append-system-prompt') + 1]).toMatch(/# Skill: fake-skill/);
        expect(argv).not.toContain('Read');
        expect(env.token).toBe(true);
        expect(env.apiKey).toBe(false);
        expect(env.HOME).toContain(path.join('apps', gw.appA.id, 'home'));
    });

    test('?wait returns the finished job and result in one call', async () => {
        const res = await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'success' } }).query({
            wait: 20,
        });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('succeeded');
        expect(res.body.data.result.output).toEqual({ summary: 'ok', findings: [] });
    });
});

describe('failures and the retry ladder', () => {
    test('missing structured output fails without retrying', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'no_output' } });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job).toMatchObject({ status: 'failed', attemptCount: 1, error: { code: 'SKILL_OUTPUT_INVALID' } });
    });

    test('a crash before acting retries fresh until the limit, then fails', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'crash' } });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('failed');
        expect(job.attempts.map((a) => a.mode)).toEqual(['fresh', 'fresh', 'fresh']);
        expect(job.attempts.every((a) => a.errorClass === 'provider_crash')).toBe(true);
    });

    test('a crash after an outside effect resumes the session, then needs review', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'bash_then_crash' } });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('needs_review');
        expect(job.attempts.map((a) => a.mode)).toEqual(['fresh', 'resume', 'resume']);
        const attempts = await attemptsOf(jobId);
        expect(attempts.every((a) => a.actedOutsideWorkspace)).toBe(true);
        const resumeArgv = JSON.parse(
            fs.readFileSync(path.join(attempts[1].workspacePath, 'fake-argv.json'), 'utf8'),
        )[1].argv;
        expect(resumeArgv[resumeArgv.indexOf('--resume') + 1]).toBe(attempts[0].claudeSessionId);
        expect(resumeArgv[1]).toMatch(/previous run of this job was interrupted/);
    });

    test('an auth failure retries uncounted, bounded, and records the class', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'auth' } });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('failed');
        expect(job.attempts.length).toBe(9);
        expect(job.attempts.every((a) => a.errorClass === 'provider_auth')).toBe(true);
    });

    test('a plan limit pauses the scope and parks the job in waiting_limit', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'limit' } });
        const job = await waitForJob(gw.http, gw.appA, jobId, (j) => j.status === 'waiting_limit');
        expect(job.attempts[0].errorClass).toBe('provider_limit');
        const pause = await ProviderState.findOne({ where: { key: 'pause:global' }, raw: true });
        expect(new Date(pause.value.until).getTime()).toBeGreaterThan(Date.now());
        const usage = await ProviderState.findOne({ where: { key: 'usage' }, raw: true });
        expect(usage.value.status).toBe('rejected');
        const other = await run({ skill: 'fake-skill', input: { scenario: 'success' } });
        await sleep(1500);
        expect((await gw.http.get(`/api/v1/jobs/${other}`).set(gw.appA.auth)).body.data.status).toBe('queued');
    });
});

describe('stopping runs', () => {
    test('cancel stops a running job', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'hang' } });
        await waitForJob(gw.http, gw.appA, jobId, (j) => j.status === 'running');
        await sleep(500);
        const res = await gw.http.post(`/api/v1/jobs/${jobId}/cancel`).set(gw.appA.auth);
        expect(res.body.data.status).toBe('cancelling');
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job).toMatchObject({ status: 'cancelled', possiblyPartial: false });
    });

    test('the timeout ends a hanging run as timed_out', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'hang' }, timeoutSec: 2 });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('timed_out');
        expect(job.attempts.every((a) => a.errorClass === 'timeout')).toBe(true);
    });

    test('the hard budget cap cancels an expensive run', async () => {
        await gw.http
            .patch(`/api/v1/admin/apps/${gw.appA.id}`)
            .set(gw.admin.auth)
            .send({ dailyTokenBudget: 30000 })
            .expect(200);
        await worker.stop();
        worker = await startWorker();
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'expensive' } });
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('failed');
        expect(job.error.code).toBe('BUDGET_EXCEEDED');
        expect(job.attempts).toHaveLength(1);
    });
});

describe('worker restarts', () => {
    test('a running attempt survives a worker restart and is re-attached without duplicate events', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'slow' } });
        await waitForJob(gw.http, gw.appA, jobId, (j) => j.status === 'running');
        await sleep(600);
        await worker.stop();
        await sleep(800);
        worker = new Worker();
        await worker.start();
        const job = await waitForJob(gw.http, gw.appA, jobId);
        expect(job.status).toBe('succeeded');
        expect(job.attempts).toHaveLength(1);
        const events = (await gw.http.get(`/api/v1/jobs/${jobId}/events?limit=200`).set(gw.appA.auth)).body.data.items;
        const texts = events.filter((e) => e.type === 'assistant_text');
        expect(texts).toHaveLength(20);
        const seqs = events.filter((e) => e.type !== 'status').map((e) => e.seq);
        expect(new Set(seqs).size).toBe(seqs.length);
    });
});

describe('scheduling', () => {
    test('long jobs use at most one slot; quick jobs still run', async () => {
        const longA = await run({ skill: 'fake-long-skill', input: { scenario: 'hang' } });
        const longB = await run({ skill: 'fake-long-skill', input: { scenario: 'hang' } });
        await waitForJob(gw.http, gw.appA, longA, (j) => j.status === 'running');
        const quick = await run({ skill: 'fake-skill', input: { scenario: 'success' } });
        expect((await waitForJob(gw.http, gw.appA, quick)).status).toBe('succeeded');
        expect((await gw.http.get(`/api/v1/jobs/${longB}`).set(gw.appA.auth)).body.data.status).toBe('queued');
        await gw.http.post(`/api/v1/jobs/${longA}/cancel`).set(gw.appA.auth);
        await waitForJob(gw.http, gw.appA, longB, (j) => j.status === 'running');
        await gw.http.post(`/api/v1/jobs/${longB}/cancel`).set(gw.appA.auth);
        await waitForJob(gw.http, gw.appA, longB);
    });

    test('a manual retry re-queues a failed job as a fresh attempt', async () => {
        const jobId = await run({ skill: 'fake-skill', input: { scenario: 'no_output' } });
        await waitForJob(gw.http, gw.appA, jobId);
        expect((await gw.http.post(`/api/v1/jobs/${jobId}/retry`).set(gw.appA.auth)).status).toBe(202);
        const job = await waitForJob(gw.http, gw.appA, jobId, (j) => j.status === 'failed' && j.attempts.length === 2);
        expect(job.attempts[1].mode).toBe('fresh');
    });
});

describe('sessions', () => {
    test('the second job in a session resumes the first job’s Claude session in the same workspace', async () => {
        const { sessionId } = (await gw.http.post('/api/v1/sessions').set(gw.appA.auth).send({ name: 'chat' })).body
            .data;
        const first = await run({ skill: 'fake-skill', input: { scenario: 'success' }, sessionId });
        expect((await waitForJob(gw.http, gw.appA, first)).status).toBe('succeeded');
        const second = await run({ skill: 'fake-skill', input: { scenario: 'success' }, sessionId });
        expect((await waitForJob(gw.http, gw.appA, second)).status).toBe('succeeded');
        const [a1] = await attemptsOf(first);
        const [a2] = await attemptsOf(second);
        expect(a2.workspacePath).toBe(a1.workspacePath);
        const runs = JSON.parse(fs.readFileSync(path.join(a2.workspacePath, 'fake-argv.json'), 'utf8'));
        expect(runs[1].argv[runs[1].argv.indexOf('--resume') + 1]).toBe(a1.claudeSessionId);
        const session = (await gw.http.get(`/api/v1/sessions/${sessionId}`).set(gw.appA.auth)).body.data;
        expect(session).toMatchObject({ busy: false, hasHistory: true });
    });
});
