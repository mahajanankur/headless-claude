'use strict';

const config = require('../../config');

const { getSecrets } = require('./secrets');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

let client = null;
let initialised = false;

const createClient = () => {
    if (!config.get('langfuse.enabled')) return null;
    const { langfusePublicKey, langfuseSecretKey } = getSecrets();
    if (!langfusePublicKey || !langfuseSecretKey) {
        logger.warn('LangFuse is enabled but its keys are missing; tracing is off.');
        return null;
    }
    const { Langfuse } = require('langfuse');
    const instance = new Langfuse({
        publicKey: langfusePublicKey,
        secretKey: langfuseSecretKey,
        baseUrl: config.get('langfuse.baseUrl'),
        flushAt: config.get('langfuse.flushAt'),
        flushInterval: config.get('langfuse.flushIntervalMs'),
        requestTimeout: config.get('langfuse.requestTimeoutMs'),
    });
    instance.on('error', (error) => logger.warn(`LangFuse export failed: ${error && error.message}`));
    return instance;
};

const getClient = () => {
    if (!initialised) {
        client = createClient();
        initialised = true;
    }
    return client;
};

/**
 * Send one attempt's trace (built by trace.service). Never throws: tracing must not affect jobs.
 * @param {{trace: Object, span: Object, generations: Object[], events: Object[]}} payload
 * @returns {void}
 */
const recordAttemptTrace = (payload) => {
    const lf = getClient();
    if (!lf) return;
    try {
        const trace = lf.trace(payload.trace);
        const span = trace.span(payload.span);
        payload.generations.forEach((g) => span.generation(g).end({ endTime: g.endTime }));
        payload.events.forEach((e) => span.event(e));
        span.end({ endTime: payload.span.endTime });
    } catch (error) {
        logger.warn(`LangFuse trace skipped: ${error.message}`);
    }
};

/** @returns {boolean} */
const isTracingEnabled = () => Boolean(getClient());

/** Flush pending events (worker shutdown). @returns {Promise<void>} */
const shutdownTracing = async () => {
    if (client) await client.shutdownAsync().catch((error) => logger.warn(`LangFuse flush failed: ${error.message}`));
};

/** Test hook: use a stub client (or null to reset). */
const setTracingClientForTests = (stub) => {
    client = stub;
    initialised = true;
};

module.exports = { recordAttemptTrace, isTracingEnabled, shutdownTracing, setTracingClientForTests };
