'use strict';

const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { setupGateway, startWorker, waitForJob, submit } = require('../helpers/gateway');
const notifyHub = require('../../src/infra/notifyHub');
const { setTracingClientForTests } = require('../../src/infra/langfuse');

jest.setTimeout(60000);

/** Minimal stand-in for the LangFuse client that records what the gateway sends. */
const recordingClient = () => {
    const sent = [];
    const node = (kind, body) => {
        const entry = { kind, body, children: [] };
        return {
            entry,
            span: (b) => {
                const child = node('span', b);
                entry.children.push(child.entry);
                return child;
            },
            generation: (b) => {
                const child = node('generation', b);
                entry.children.push(child.entry);
                return child;
            },
            event: (b) => entry.children.push({ kind: 'event', body: b, children: [] }),
            end: () => {},
        };
    };
    return {
        sent,
        trace: (b) => {
            const t = node('trace', b);
            sent.push(t.entry);
            return t;
        },
        shutdownAsync: async () => {},
    };
};

let gw;
let worker;
let client;

beforeAll(() => assertLocalTestDb());
beforeEach(async () => {
    client = recordingClient();
    setTracingClientForTests(client);
    gw = await setupGateway();
    worker = await startWorker();
});
afterEach(async () => {
    await worker.stop();
    setTracingClientForTests(null);
});
afterAll(async () => {
    await notifyHub.stop();
    await sequelize.close();
});

test('a finished job is sent as one trace with an attempt span, generations and tool events', async () => {
    const { jobId } = (await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'write_out' } })).body
        .data;
    expect((await waitForJob(gw.http, gw.appA, jobId)).status).toBe('succeeded');
    const trace = client.sent.find((t) => t.body.id === jobId);
    expect(trace.body).toMatchObject({ name: 'job:fake-skill', userId: gw.appA.id, output: { status: 'succeeded' } });
    const [span] = trace.children;
    expect(span.kind).toBe('span');
    expect(span.children.filter((c) => c.kind === 'generation').length).toBeGreaterThan(0);
    expect(span.children.find((c) => c.kind === 'event').body.name).toBe('tool:Write');
});

test('every attempt of a retried job is traced under the same job trace id', async () => {
    const { jobId } = (await submit(gw.http, gw.appA, { skill: 'fake-skill', input: { scenario: 'crash' } })).body.data;
    expect((await waitForJob(gw.http, gw.appA, jobId)).status).toBe('failed');
    const traces = client.sent.filter((t) => t.body.id === jobId);
    expect(traces).toHaveLength(3);
    expect(traces.map((t) => t.children[0].body.level)).toEqual(['ERROR', 'ERROR', 'ERROR']);
});
