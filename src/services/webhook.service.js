'use strict';

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');

const config = require('../../config');

const webhookDeliveryRepository = require('../repositories/webhookDelivery.repository');
const jobRepository = require('../repositories/job.repository');
const appRepository = require('../repositories/app.repository');
const { getWebhookSecret } = require('./app.service');
const { withTransaction } = require('../utils/transaction');
const { isPrivateAddress, assertSafeOutboundUrl } = require('../utils/netGuard');
const { backoffSec } = require('../utils/backoff');
const getLogger = require('../utils/logger');
const { WEBHOOK_STATUS } = require('../constants/delivery');

const logger = getLogger(__filename);

const TIMEOUT_MS = config.get('webhook.timeoutMs');
const MAX_ATTEMPTS = config.get('webhook.maxAttempts');
const MAX_AGE_MS = config.get('webhook.maxAgeHours') * 3600e3;
const ALLOW_PRIVATE = config.get('webhook.allowPrivateHosts');
// one delivery is leased right before it is sent; the lease covers DNS + connect + a slow body
const LEASE_MS = TIMEOUT_MS * 4;
const BATCH = config.get('webhook.batchSize');

/**
 * Signature header value: `t=<unix>,v1=<hex hmac-sha256("<t>.<body>")>`.
 * @param {string} secret
 * @param {string} body
 * @param {number} timestamp unix seconds
 * @returns {string}
 */
const signPayload = (secret, body, timestamp) =>
    `t=${timestamp},v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/** DNS lookup that refuses private addresses at connect time (blocks DNS rebinding). */
const guardedLookup = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const allowed = ALLOW_PRIVATE ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
        if (!allowed.length) return callback(new Error('Webhook host resolves to a private address.'));
        if (options.all) return callback(null, allowed);
        return callback(null, allowed[0].address, allowed[0].family);
    });
};

const post = (url, body, headers) =>
    new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
                lookup: guardedLookup,
                timeout: TIMEOUT_MS,
            },
            (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            },
        );
        req.on('timeout', () => req.destroy(new Error(`Timed out after ${TIMEOUT_MS} ms`)));
        const deadline = setTimeout(
            () => req.destroy(new Error(`No response within ${TIMEOUT_MS * 2} ms`)),
            TIMEOUT_MS * 2,
        );
        req.on('close', () => clearTimeout(deadline));
        req.on('error', reject);
        req.end(body);
    });

const leaseNext = () =>
    withTransaction('webhook.lease', async (transaction) => {
        const [due] = await webhookDeliveryRepository.lockDueInternal(1, { transaction });
        if (due)
            await webhookDeliveryRepository.updateInternal(
                due.id,
                { nextAttemptAt: new Date(Date.now() + LEASE_MS) },
                { transaction },
            );
        return due || null;
    });

const sendOne = async (delivery) => {
    const job = await jobRepository.findByIdInternal(delivery.jobId);
    const app = await appRepository.findByIdInternal(delivery.appId);
    if (!job || !app || !job.webhookUrl) throw new Error('Job or app no longer exists.');
    const url = await assertSafeOutboundUrl(job.webhookUrl, {
        allowedHosts: app.webhookAllowedHosts,
        allowPrivate: ALLOW_PRIVATE,
    });
    const body = JSON.stringify({
        event: 'job.finished',
        jobId: job.id,
        status: job.status,
        finishedAt: job.finishedAt,
    });
    const secret = getWebhookSecret(app);
    const headers = { 'User-Agent': 'headless-claude', 'X-Gateway-Delivery': delivery.id };
    if (secret) headers['X-Gateway-Signature'] = signPayload(secret, body, Math.floor(Date.now() / 1000));
    const status = await post(url, body, headers);
    if (status < 200 || status >= 300) throw new Error(`Receiver answered HTTP ${status}`);
};

const recordFailure = async (delivery, error) => {
    const attempts = delivery.attempts + 1;
    const tooOld = Date.now() - new Date(delivery.createdAt).getTime() > MAX_AGE_MS;
    const giveUp = attempts >= MAX_ATTEMPTS || tooOld;
    await webhookDeliveryRepository.updateInternal(delivery.id, {
        attempts,
        lastError: String(error.message).slice(0, 500),
        status: giveUp ? WEBHOOK_STATUS.FAILED : WEBHOOK_STATUS.PENDING,
        nextAttemptAt: new Date(Date.now() + backoffSec(attempts, { baseSec: 10, maxSec: 3600 }) * 1000),
    });
    if (giveUp) logger.warn(`Webhook gave up for job ${delivery.jobId}: ${error.message}`);
};

/**
 * Deliver due webhooks one at a time: lease (transaction) → send (after commit, no I/O in the transaction)
 * → record. Leasing right before sending means a slow batch never lets another worker re-send an item.
 * @returns {Promise<{delivered: number, failed: number}>}
 */
const dispatchDueWebhooks = async () => {
    let delivered = 0;
    let failed = 0;
    for (let i = 0; i < BATCH; i += 1) {
        const delivery = await leaseNext();
        if (!delivery) break;
        try {
            await sendOne(delivery);
            await webhookDeliveryRepository.updateInternal(delivery.id, {
                status: WEBHOOK_STATUS.DELIVERED,
                attempts: delivery.attempts + 1,
                lastError: null,
            });
            delivered += 1;
        } catch (error) {
            await recordFailure(delivery, error);
            failed += 1;
        }
    }
    return { delivered, failed };
};

module.exports = { dispatchDueWebhooks, signPayload };
