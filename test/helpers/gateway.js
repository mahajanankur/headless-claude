'use strict';

const request = require('supertest');

const { createApp } = require('../../src/api/app');
const appService = require('../../src/services/app.service');
const skillService = require('../../src/services/skill.service');
const notifyHub = require('../../src/infra/notifyHub');
const { Worker } = require('../../src/worker/worker');
const { CHANNELS } = require('../../src/constants/eventTypes');
const { FEATURES } = require('../../src/constants/features');
const { truncateAll } = require('./db');

const ALL_FEATURES = Object.fromEntries(Object.values(FEATURES).map((f) => [f, true]));
const TEST_SKILLS = ['fake-skill', 'fake-repo-skill', 'fake-long-skill', 'chat'];

/**
 * Fresh database, skills synced, notify hub listening, and two apps (A with every feature, B plain).
 * @returns {Promise<{http: Function, appA: Object, appB: Object, admin: Object}>}
 */
const setupGateway = async ({ appA: overridesA = {} } = {}) => {
    await truncateAll();
    await skillService.syncFromDisk();
    await notifyHub.start([CHANNELS.JOB_EVENTS]);
    const make = async (name, extra) => {
        const { app, apiKey } = await appService.createApp({
            name,
            allowedSkills: TEST_SKILLS,
            allowedModels: ['haiku', 'sonnet'],
            ...extra,
        });
        return { ...app, key: apiKey, auth: { Authorization: `Bearer ${apiKey}` } };
    };
    const appA = await make('app-a', {
        features: ALL_FEATURES,
        maxConcurrent: 2,
        webhookAllowedHosts: ['127.0.0.1'],
        ...overridesA,
    });
    const appB = await make('app-b', {});
    const admin = await make('admin', { isAdmin: true });
    return { http: request(createApp()), appA, appB, admin };
};

/**
 * Start an in-process worker (local runner + fake claude).
 * @returns {Promise<Worker>}
 */
const startWorker = async () => {
    const worker = new Worker();
    await worker.start();
    return worker;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a job until `predicate(job)` holds or the timeout passes.
 * @returns {Promise<Object>} the job
 */
const isFinished = (j) => ['succeeded', 'failed', 'timed_out', 'needs_review', 'cancelled'].includes(j.status);

/**
 * Poll a job until `predicate(job)` holds or the timeout passes.
 * @returns {Promise<Object>} the job
 */
const waitForJob = async (http, app, jobId, predicate = isFinished, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    let job;
    while (Date.now() < deadline) {
        job = (await http.get(`/api/v1/jobs/${jobId}`).set(app.auth)).body.data;
        if (job && predicate(job)) return job;
        await sleep(100);
    }
    throw new Error(`Job ${jobId} did not reach the expected state; last: ${JSON.stringify(job && job.status)}`);
};

const submit = (http, app, body, headers = {}) => http.post('/api/v1/jobs').set(app.auth).set(headers).send(body);

module.exports = { setupGateway, startWorker, waitForJob, submit, sleep, ALL_FEATURES };
