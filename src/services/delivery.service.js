'use strict';

const jobRepository = require('../repositories/job.repository');
const artifactRepository = require('../repositories/artifact.repository');
const { withTransaction } = require('../utils/transaction');
const { recordAudit } = require('./audit.service');
const { ConflictError, NotFoundError } = require('../utils/AppError');
const { AUDIT_ACTION } = require('../constants/audit');
const { API_ERROR } = require('../constants/apiErrors');
const { JOB_STATUS } = require('../constants/jobStatus');
const { DELIVERY_STATUS } = require('../constants/delivery');

/**
 * Record how code changes were delivered after a successful job (decision D24).
 * A delivery failure never changes the job's success.
 * @param {Object} job
 * @param {{status: string, error?: string, branch?: string, prUrl?: string, artifacts?: Object[]}} delivery
 * @returns {Promise<void>}
 */
const recordDelivery = (job, delivery) =>
    withTransaction('delivery.record', async (transaction) => {
        await jobRepository.updateGuarded(
            job.id,
            [JOB_STATUS.SUCCEEDED],
            {
                deliveryStatus: delivery.status,
                deliveryError: delivery.error || null,
                branch: delivery.branch || null,
                prUrl: delivery.prUrl || null,
            },
            { transaction },
        );
        const artifacts = (delivery.artifacts || []).map((a) => ({ ...a, jobId: job.id, appId: job.appId }));
        if (artifacts.length) await artifactRepository.bulkCreate(artifacts, { transaction });
    });

/**
 * Succeeded jobs whose delivery never completed (worker died between finishing and delivering).
 * @param {Date} olderThan
 * @returns {Promise<Object[]>}
 */
const strandedDeliveries = (olderThan) =>
    jobRepository.findPendingDeliveriesInternal(DELIVERY_STATUS.PENDING, olderThan);

/**
 * Admin: retry a failed code delivery. The job goes back to delivery `pending`; the worker's reaper
 * re-runs the delivery from the kept workspace on its next tick.
 * @param {string} jobId
 * @returns {Promise<{jobId: string, delivery: string}>}
 * @throws {NotFoundError|ConflictError}
 */
const requestRedelivery = async (jobId) => {
    const job = await jobRepository.findByIdInternal(jobId);
    if (!job) throw new NotFoundError('Job not found.', API_ERROR.JOB_NOT_FOUND);
    if (job.status !== JOB_STATUS.SUCCEEDED || job.deliveryStatus !== DELIVERY_STATUS.FAILED) {
        throw new ConflictError(
            'Only succeeded jobs whose delivery failed can be redelivered.',
            API_ERROR.INVALID_STATE,
        );
    }
    await withTransaction('delivery.redeliver', async (transaction) => {
        await jobRepository.updateGuarded(
            jobId,
            [JOB_STATUS.SUCCEEDED],
            { deliveryStatus: DELIVERY_STATUS.PENDING, deliveryError: null },
            { transaction },
        );
        await recordAudit(
            { appId: job.appId, action: AUDIT_ACTION.JOB_REDELIVERED, targetType: 'job', targetId: jobId },
            { transaction },
        );
    });
    return { jobId, delivery: DELIVERY_STATUS.PENDING };
};

module.exports = { recordDelivery, strandedDeliveries, requestRedelivery };
