'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { io: ioClient } = require('socket.io-client');

const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { setupGateway, startWorker, waitForJob, submit } = require('../helpers/gateway');
const notifyHub = require('../../src/infra/notifyHub');
const { createApp } = require('../../src/api/app');
const { attachSocket } = require('../../src/api/socket');
const { CHANNELS } = require('../../src/constants/eventTypes');

jest.setTimeout(60000);

let gw;
let worker;
let tmp;

const git = (args, cwd) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
        .toString()
        .trim();

/** A bare "remote" repository with one commit on main. */
const makeRemote = () => {
    const seed = path.join(tmp, 'seed');
    const remote = path.join(tmp, 'remote.git');
    fs.mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# Demo\n');
    fs.mkdirSync(path.join(seed, '.claude'));
    fs.writeFileSync(
        path.join(seed, '.claude', 'settings.json'),
        '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/gw-hostile-hook"}]}]}}',
    );
    git(['add', '.'], seed);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], seed);
    git(['clone', '-q', '--bare', seed, remote], tmp);
    return remote;
};

beforeAll(() => assertLocalTestDb());
beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-delivery-'));
    gw = await setupGateway();
    worker = await startWorker();
});
afterEach(async () => {
    await worker.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(async () => {
    await notifyHub.stop();
    await sequelize.close();
});

describe('change delivery', () => {
    test('edits in the cloned repo are pushed to a new branch; Claude never sees .git', async () => {
        const remote = makeRemote();
        const res = await submit(gw.http, gw.appA, {
            skill: 'fake-repo-skill',
            input: { repoUrl: `file://${remote}`, ref: 'main', scenario: 'edit_repo' },
        });
        expect(res.status).toBe(202);
        const job = await waitForJob(
            gw.http,
            gw.appA,
            res.body.data.jobId,
            (j) => j.delivery && j.delivery.status !== 'pending',
        );
        expect(job.status).toBe('succeeded');
        expect(job.delivery).toMatchObject({
            status: 'delivered',
            branch: expect.stringMatching(/^gw\/fake-repo-skill\/[0-9a-f]{8}-a1$/),
        });
        const readme = git(['show', `${job.delivery.branch}:README.md`], remote);
        expect(readme).toContain('Edited by the fake agent.');
        const result = (await gw.http.get(`/api/v1/jobs/${job.jobId}/result`).set(gw.appA.auth)).body.data;
        expect(result.artifacts.map((a) => a.name)).toContain('changes.patch');
    });

    test('an unchanged repo reports no_changes', async () => {
        const remote = makeRemote();
        const res = await submit(gw.http, gw.appA, {
            skill: 'fake-repo-skill',
            input: { repoUrl: `file://${remote}`, ref: 'main', scenario: 'success' },
        });
        const job = await waitForJob(
            gw.http,
            gw.appA,
            res.body.data.jobId,
            (j) => j.delivery && j.delivery.status !== 'pending',
        );
        expect(job.delivery).toMatchObject({ status: 'no_changes' });
    });

    test('a clone failure finishes failed (bounded infra retries), not forever', async () => {
        const res = await submit(gw.http, gw.appA, {
            skill: 'fake-repo-skill',
            input: { repoUrl: `file://${tmp}/missing.git`, ref: 'main' },
        });
        const job = await waitForJob(gw.http, gw.appA, res.body.data.jobId, undefined, 40000);
        expect(job.status).toBe('failed');
        expect(job.error.message).toMatch(/clone failed/);
    });
});

describe('webhooks', () => {
    test('a signed webhook is delivered when the job finishes', async () => {
        const secret = 'whsec-0123456789abcdef';
        await gw.http
            .patch(`/api/v1/admin/apps/${gw.appA.id}`)
            .set(gw.admin.auth)
            .send({ webhookSecret: secret })
            .expect(200);
        await worker.stop();
        worker = await startWorker();
        let resolveDelivery;
        const received = new Promise((resolve) => {
            resolveDelivery = resolve;
        });
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                res.end('ok');
                resolveDelivery({ body, signature: req.headers['x-gateway-signature'] });
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/hook`;
        const submitted = await submit(gw.http, gw.appA, {
            skill: 'fake-skill',
            input: { scenario: 'success' },
            webhookUrl: url,
        });
        expect(submitted.status).toBe(202);
        const { body, signature } = await received;
        server.close();
        const payload = JSON.parse(body);
        expect(payload).toMatchObject({ event: 'job.finished', status: 'succeeded' });
        const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
        expect(crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')).toBe(v1);
    });
});

describe('live progress', () => {
    test('SSE streams events and ends with the final status (API key)', async () => {
        const res = await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'slow' } });
        const sse = await gw.http
            .get(`/api/v1/jobs/${res.body.data.jobId}/stream`)
            .set(gw.appA.auth)
            .buffer(true)
            .parse((r, cb) => {
                let data = '';
                r.on('data', (c) => (data += c));
                r.on('end', () => cb(null, data));
            });
        expect(sse.headers['content-type']).toMatch(/text\/event-stream/);
        expect(sse.body).toMatch(/event: job-event/);
        expect(sse.body).toMatch(/event: end\ndata: \{"status":"succeeded"\}/);
    });

    test('SSE with a stream token works for its job only; app B cannot stream app A job', async () => {
        const { jobId } = (await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'success' } })).body
            .data;
        const { token } = (await gw.http.post(`/api/v1/jobs/${jobId}/stream-token`).set(gw.appA.auth)).body.data;
        const other = (await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'success' } })).body
            .data.jobId;
        expect((await gw.http.get(`/api/v1/jobs/${other}/stream?token=${token}`)).status).toBe(403);
        expect((await gw.http.get(`/api/v1/jobs/${jobId}/stream?token=bad`)).status).toBe(401);
        expect((await gw.http.get(`/api/v1/jobs/${jobId}/stream`).set(gw.appB.auth)).status).toBe(404);
        await waitForJob(gw.http, gw.appA, jobId);
        const ok = await gw.http.get(`/api/v1/jobs/${jobId}/stream?token=${token}`);
        expect(ok.status).toBe(200);
        expect(ok.text).toMatch(/event: end/);
    });

    test('Socket.IO streams events with a stream token', async () => {
        const server = http.createServer(createApp());
        const io = attachSocket(server);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        await notifyHub.start([CHANNELS.JOB_EVENTS]);
        try {
            const { jobId } = (await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'slow' } }))
                .body.data;
            const { token } = (await gw.http.post(`/api/v1/jobs/${jobId}/stream-token`).set(gw.appA.auth)).body.data;
            const client = ioClient(`http://127.0.0.1:${server.address().port}/jobs`, {
                auth: { token },
                transports: ['websocket'],
            });
            const outcome = await new Promise((resolve, reject) => {
                let count = 0;
                client.on('connect_error', reject);
                client.on('connect', () => client.emit('subscribe', { jobId }));
                client.on('job-event', ({ events }) => (count += events.length));
                client.on('job-end', ({ status }) => resolve({ status, count }));
            });
            client.close();
            expect(outcome.status).toBe('succeeded');
            expect(outcome.count).toBeGreaterThan(10);
        } finally {
            io.close();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('Socket.IO rejects a bad credential', async () => {
        const server = http.createServer(createApp());
        const io = attachSocket(server);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const client = ioClient(`http://127.0.0.1:${server.address().port}/jobs`, {
                auth: { token: 'bad' },
                transports: ['websocket'],
            });
            const error = await new Promise((resolve) => client.on('connect_error', resolve));
            client.close();
            expect(error.message).toMatch(/invalid or expired/);
        } finally {
            io.close();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
