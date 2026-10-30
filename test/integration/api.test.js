'use strict';

const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { setupGateway, submit } = require('../helpers/gateway');
const notifyHub = require('../../src/infra/notifyHub');

let gw;

beforeAll(() => assertLocalTestDb());
beforeEach(async () => {
    gw = await setupGateway();
});
afterAll(async () => {
    await notifyHub.stop();
    await sequelize.close();
});

const job = { skill: 'fake-skill', input: { scenario: 'success' } };

describe('envelope, health and auth', () => {
    test('health has no auth and uses the envelope', async () => {
        const res = await gw.http.get('/api/v1/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
        expect(res.body.requestId).toEqual(res.headers['x-request-id']);
    });

    test('ready reports the database', async () => {
        const res = await gw.http.get('/api/v1/ready');
        expect(res.status).toBe(200);
        expect(res.body.data.database).toBe(true);
    });

    test.each([
        ['no header', {}],
        ['malformed key', { Authorization: 'Bearer nope' }],
        ['unknown key', { Authorization: 'Bearer gwk_unknownunknownunknownunknownunknown' }],
    ])('401 with %s', async (_label, headers) => {
        const res = await gw.http.get('/api/v1/jobs').set(headers);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    test('unknown route is a 404 envelope', async () => {
        const res = await gw.http.get('/api/v1/nope').set(gw.appA.auth);
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test('invalid JSON is a 400 envelope', async () => {
        const res = await gw.http
            .post('/api/v1/jobs')
            .set(gw.appA.auth)
            .set('Content-Type', 'application/json')
            .send('{bad');
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INPUT_INVALID');
    });
});

describe('submit validation and authorisation', () => {
    test('202 with a job id', async () => {
        const res = await submit(gw.http, gw.appA, job);
        expect(res.status).toBe(202);
        expect(res.body.data).toMatchObject({ status: 'queued', skill: 'fake-skill', model: 'haiku' });
    });

    test.each([
        ['unknown field', { ...job, extra: 1 }, /Unknown field/],
        ['bad skill name', { ...job, skill: 'Bad Skill' }, /Skill \(skill\)/],
        ['input not an object', { ...job, input: 'x' }, /Input \(input\)/],
        ['timeout above the skill limit', { ...job, timeoutSec: 61 }, /Timeout \(timeoutSec\)/],
        ['bad priority', { ...job, priority: 'urgent' }, /Priority/],
    ])('400 for %s', async (_label, body, message) => {
        const res = await submit(gw.http, gw.appA, body);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(message);
    });

    test('403 for a skill the app may not use, 404 for a missing skill', async () => {
        const forbidden = await submit(gw.http, { auth: gw.admin.auth }, { ...job, skill: 'repo-review' });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('FORBIDDEN_SKILL');
    });

    test('403 for a model outside the app allow-list', async () => {
        const res = await submit(gw.http, gw.appA, { ...job, model: 'opus' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_MODEL');
    });

    test('urgent requires an admin app', async () => {
        expect((await submit(gw.http, gw.appA, { ...job, urgent: true })).status).toBe(403);
    });

    test('webhooks require the flag and an allow-listed host', async () => {
        const off = await submit(gw.http, gw.appB, { ...job, webhookUrl: 'https://example.com/h' });
        expect(off.status).toBe(400);
        const notAllowed = await submit(gw.http, gw.appA, { ...job, webhookUrl: 'https://example.com/h' });
        expect(notAllowed.body.message).toMatch(/allow-list/);
    });
});

describe('isolation and idempotency', () => {
    test('app B gets 404 for app A job, result, events and cancel', async () => {
        const { jobId } = (await submit(gw.http, gw.appA, job)).body.data;
        for (const path of [`/api/v1/jobs/${jobId}`, `/api/v1/jobs/${jobId}/result`, `/api/v1/jobs/${jobId}/events`]) {
            expect((await gw.http.get(path).set(gw.appB.auth)).status).toBe(404);
        }
        expect((await gw.http.post(`/api/v1/jobs/${jobId}/cancel`).set(gw.appB.auth)).status).toBe(404);
        const list = await gw.http.get('/api/v1/jobs').set(gw.appB.auth);
        expect(list.body.data.items).toHaveLength(0);
    });

    test('same key + same body returns the job; different body is 409', async () => {
        const headers = { 'Idempotency-Key': 'order-42' };
        const first = await submit(gw.http, gw.appA, job, headers);
        const again = await submit(gw.http, gw.appA, job, headers);
        expect(again.status).toBe(200);
        expect(again.body.data.jobId).toBe(first.body.data.jobId);
        const conflict = await submit(gw.http, gw.appA, { ...job, input: { scenario: 'crash' } }, headers);
        expect(conflict.status).toBe(409);
        expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    test('list paginates with a cursor', async () => {
        for (let i = 0; i < 3; i += 1) await submit(gw.http, gw.appA, job);
        const first = await gw.http.get('/api/v1/jobs?limit=2').set(gw.appA.auth);
        expect(first.body.data.items).toHaveLength(2);
        const second = await gw.http.get(`/api/v1/jobs?limit=2&cursor=${first.body.data.nextCursor}`).set(gw.appA.auth);
        expect(second.body.data.items).toHaveLength(1);
        expect(second.body.data.nextCursor).toBeNull();
    });
});

describe('cancel and retry of queued jobs', () => {
    test('cancelling a queued job is immediate; a second cancel is 409', async () => {
        const { jobId } = (await submit(gw.http, gw.appA, job)).body.data;
        const res = await gw.http.post(`/api/v1/jobs/${jobId}/cancel`).set(gw.appA.auth);
        expect(res.body.data.status).toBe('cancelled');
        expect((await gw.http.post(`/api/v1/jobs/${jobId}/cancel`).set(gw.appA.auth)).status).toBe(409);
        expect((await gw.http.post(`/api/v1/jobs/${jobId}/retry`).set(gw.appA.auth)).status).toBe(409);
    });

    test('result before finishing is 409', async () => {
        const { jobId } = (await submit(gw.http, gw.appA, job)).body.data;
        expect((await gw.http.get(`/api/v1/jobs/${jobId}/result`).set(gw.appA.auth)).status).toBe(409);
    });
});

describe('skills, sessions, stream tokens and feature flags', () => {
    test('skills list is filtered to the app', async () => {
        const res = await gw.http.get('/api/v1/skills').set(gw.appA.auth);
        expect(res.body.data.items.map((s) => s.name).sort()).toEqual([
            'chat',
            'fake-long-skill',
            'fake-repo-skill',
            'fake-skill',
        ]);
        expect((await gw.http.get('/api/v1/skills/repo-review').set(gw.appA.auth)).status).toBe(403);
    });

    test('sessions and stream tokens are hidden (404) when the flag is off', async () => {
        expect((await gw.http.post('/api/v1/sessions').set(gw.appB.auth).send({})).status).toBe(404);
        const { jobId } = (await submit(gw.http, gw.appB, job)).body.data;
        expect((await gw.http.post(`/api/v1/jobs/${jobId}/stream-token`).set(gw.appB.auth)).status).toBe(404);
    });

    test('sessions can be created, read and deleted', async () => {
        const created = await gw.http
            .post('/api/v1/sessions')
            .set(gw.appA.auth)
            .send({ name: 'review chat', ttlHours: 2 });
        expect(created.status).toBe(201);
        const id = created.body.data.sessionId;
        expect((await gw.http.get(`/api/v1/sessions/${id}`).set(gw.appA.auth)).body.data.busy).toBe(false);
        expect((await gw.http.delete(`/api/v1/sessions/${id}`).set(gw.appA.auth)).status).toBe(200);
        expect((await gw.http.get(`/api/v1/sessions/${id}`).set(gw.appA.auth)).status).toBe(404);
    });

    test('sessions cannot be used by skills that change code', async () => {
        const { sessionId } = (await gw.http.post('/api/v1/sessions').set(gw.appA.auth).send({})).body.data;
        const res = await submit(gw.http, gw.appA, {
            skill: 'fake-repo-skill',
            input: { repoUrl: 'file:///tmp/x' },
            sessionId,
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/cannot run in a session/);
    });
});

describe('admin', () => {
    test('non-admins get 403', async () => {
        expect((await gw.http.get('/api/v1/admin/stats').set(gw.appA.auth)).status).toBe(403);
    });

    test('create an app, issue and revoke a key', async () => {
        const created = await gw.http
            .post('/api/v1/admin/apps')
            .set(gw.admin.auth)
            .send({ name: 'svc', allowedSkills: ['fake-skill'] });
        expect(created.status).toBe(201);
        const { app, apiKey } = created.body.data;
        expect(apiKey).toMatch(/^gwk_/);
        expect((await gw.http.get('/api/v1/skills').set({ Authorization: `Bearer ${apiKey}` })).status).toBe(200);
        const keys = await gw.http.get(`/api/v1/admin/apps/${app.id}/keys`).set(gw.admin.auth);
        const keyId = keys.body.data.items[0].id;
        expect(keys.body.data.items[0].keyHash).toBeUndefined();
        await gw.http.delete(`/api/v1/admin/apps/${app.id}/keys/${keyId}`).set(gw.admin.auth).expect(200);
        expect((await gw.http.get('/api/v1/skills').set({ Authorization: `Bearer ${apiKey}` })).status).toBe(401);
    });

    test('redelivery: only a succeeded job with a failed delivery; it goes back to pending', async () => {
        const { jobId } = (await submit(gw.http, gw.appA, job)).body.data;
        const url = `/api/v1/admin/jobs/${jobId}/redeliver`;
        expect((await gw.http.post(url).set(gw.admin.auth)).status).toBe(409);
        const { Job } = require('../../src/db/models');
        await Job.update(
            { status: 'succeeded', deliveryStatus: 'failed', deliveryError: 'push rejected' },
            { where: { id: jobId } },
        );
        const res = await gw.http.post(url).set(gw.admin.auth);
        expect(res.status).toBe(202);
        expect((await gw.http.get(`/api/v1/jobs/${jobId}`).set(gw.appA.auth)).body.data.delivery).toMatchObject({
            status: 'pending',
            error: null,
        });
        expect((await gw.http.post(url).set(gw.appA.auth)).status).toBe(403);
    });

    test('unknown feature flags are rejected', async () => {
        const res = await gw.http
            .patch(`/api/v1/admin/apps/${gw.appB.id}`)
            .set(gw.admin.auth)
            .send({ features: { nope: true } });
        expect(res.status).toBe(400);
    });

    test('pausing intake blocks submissions with 503', async () => {
        await gw.http.post(`/api/v1/admin/apps/${gw.appA.id}/pause`).set(gw.admin.auth).expect(200);
        const res = await submit(gw.http, gw.appA, job);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('INTAKE_PAUSED');
        await gw.http.post(`/api/v1/admin/apps/${gw.appA.id}/resume`).set(gw.admin.auth).expect(200);
        expect((await submit(gw.http, gw.appA, job)).status).toBe(202);
    });

    test('global intake pause and stats', async () => {
        await gw.http.post('/api/v1/admin/intake/pause').set(gw.admin.auth).expect(200);
        expect((await submit(gw.http, gw.appA, job)).status).toBe(503);
        await gw.http.post('/api/v1/admin/intake/resume').set(gw.admin.auth).expect(200);
        expect((await submit(gw.http, gw.appA, job)).status).toBe(202);
        const stats = await gw.http.get('/api/v1/admin/stats').set(gw.admin.auth);
        expect(stats.body.data.jobs.queued).toBe(1);
    });
});

describe('budget at submit', () => {
    test('429 with Retry-After when the daily budget is used up', async () => {
        await gw.http
            .patch(`/api/v1/admin/apps/${gw.appA.id}`)
            .set(gw.admin.auth)
            .send({ dailyTokenBudget: 10 })
            .expect(200);
        const { addTokens } = require('../../src/repositories/appUsageDaily.repository');
        const { budgetDay } = require('../../src/services/usage.service');
        await addTokens(gw.appA.id, budgetDay(new Date(), 'UTC'), 10);
        const res = await submit(gw.http, gw.appA, job);
        expect(res.status).toBe(429);
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
});
