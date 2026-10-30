'use strict';

const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { setupGateway, startWorker } = require('../helpers/gateway');
const notifyHub = require('../../src/infra/notifyHub');

jest.setTimeout(60000);

let gw;
let worker;

const send = (app, body, query = {}) => gw.http.post('/api/v1/chat').query(query).set(app.auth).send(body);

beforeAll(() => assertLocalTestDb());
beforeEach(async () => {
    gw = await setupGateway();
    worker = await startWorker();
});
afterEach(async () => worker.stop());
afterAll(async () => {
    await notifyHub.stop();
    await sequelize.close();
});

describe('chat', () => {
    test('a conversation: first message, follow-up in the same Claude session, history', async () => {
        const first = await send(gw.appA, { message: 'hello there', model: 'haiku' });
        expect(first.status).toBe(200);
        expect(first.body.data).toMatchObject({ status: 'succeeded', reply: 'Reply 1 to: hello there', error: null });
        const { sessionId } = first.body.data;

        const second = await send(gw.appA, { message: 'and again', sessionId, model: 'haiku' });
        expect(second.body.data).toMatchObject({ sessionId, status: 'succeeded', reply: 'Reply 2 to: and again' });

        const history = await gw.http.get(`/api/v1/chat/${sessionId}`).set(gw.appA.auth);
        expect(history.body.data.messages.map((m) => [m.message, m.reply])).toEqual([
            ['hello there', 'Reply 1 to: hello there'],
            ['and again', 'Reply 2 to: and again'],
        ]);
    });

    test('?wait=0 returns at once with the job to poll', async () => {
        const res = await send(gw.appA, { message: 'quick' }, { wait: 0 });
        expect(res.status).toBe(202);
        expect(res.body.data).toMatchObject({ reply: null, jobId: expect.any(String), sessionId: expect.any(String) });
    });

    test('isolation, validation and the feature flag', async () => {
        const { sessionId } = (await send(gw.appA, { message: 'mine', model: 'haiku' })).body.data;
        expect((await gw.http.get(`/api/v1/chat/${sessionId}`).set(gw.appB.auth)).status).toBe(404);
        expect((await send(gw.appB, { message: 'hi' })).status).toBe(404);
        expect((await send(gw.appA, { message: '' })).status).toBe(400);
        expect((await send(gw.appA, { message: 'x', sessionId: '00000000-0000-0000-0000-000000000000' })).status).toBe(
            404,
        );
        expect((await send(gw.appA, { message: 'x', extra: 1 })).status).toBe(400);
    });
});
