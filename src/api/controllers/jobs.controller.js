'use strict';

const fs = require('fs');

const config = require('../../../config');

const jobService = require('../../services/job.service');
const { isFeatureEnabled } = require('../../services/app.service');
const validator = require('../validators/jobs.validator');
const { Response } = require('../dtos/response.dto');
const { ValidationError } = require('../../utils/AppError');
const getLogger = require('../../utils/logger');
const { FEATURES } = require('../../constants/features');

const logger = getLogger(__filename);

const WAIT_MAX_SEC = config.get('job.waitMaxSec');
const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const idempotencyKey = (req) => {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (key !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
        throw new ValidationError(
            'Idempotency key (Idempotency-Key) must be 1-200 letters, digits or ._:- characters.',
        );
    }
    return key;
};

const respondAfterWait = async (req, res, job) => {
    if (!isFeatureEnabled(req.context.app, FEATURES.WAIT_MODE) || jobService.isWaitPointless(job)) {
        return res.status(202).json(new Response(true, 'Job queued.', job, req.context.requestId));
    }
    const waitMs = Math.min(req.query.wait, WAIT_MAX_SEC) * 1000;
    await jobService.waitForTerminal(job.jobId, req.context.appId, waitMs);
    const current = await jobService.getJob(job.jobId, req.context);
    if (current.status !== 'succeeded')
        return res.status(202).json(new Response(true, `Job is ${current.status}.`, current, req.context.requestId));
    const result = await jobService.getJobResult(job.jobId, req.context);
    return res.status(200).json(new Response(true, 'Job finished.', { ...current, result }, req.context.requestId));
};

/** POST /jobs */
const submit = async (req, res, next) => {
    try {
        await validator.submit(req);
        const { job, created } = await jobService.submitJob(req.body, req.context, {
            idempotencyKey: idempotencyKey(req),
        });
        if (!created)
            return res
                .status(200)
                .json(new Response(true, 'Existing job for this Idempotency-Key.', job, req.context.requestId));
        if (req.query.wait) return await respondAfterWait(req, res, job);
        return res.status(202).json(new Response(true, 'Job queued.', job, req.context.requestId));
    } catch (error) {
        logger.warn(`Error submitting job: ${error.message}`);
        return next(error);
    }
};

/** GET /jobs */
const list = async (req, res, next) => {
    try {
        await validator.list(req);
        const page = await jobService.listJobs(req.context, req.query);
        return res.json(new Response(true, 'Jobs.', page, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /jobs/:id */
const get = async (req, res, next) => {
    try {
        await validator.jobId(req);
        return res.json(
            new Response(true, 'Job.', await jobService.getJob(req.params.id, req.context), req.context.requestId),
        );
    } catch (error) {
        return next(error);
    }
};

/** GET /jobs/:id/result */
const result = async (req, res, next) => {
    try {
        await validator.jobId(req);
        return res.json(
            new Response(
                true,
                'Job result.',
                await jobService.getJobResult(req.params.id, req.context),
                req.context.requestId,
            ),
        );
    } catch (error) {
        return next(error);
    }
};

/** GET /jobs/:id/events */
const events = async (req, res, next) => {
    try {
        await validator.events(req);
        const page = await jobService.listJobEvents(req.params.id, req.context, req.query);
        return res.json(new Response(true, 'Job events.', page, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** POST /jobs/:id/cancel */
const cancel = async (req, res, next) => {
    try {
        await validator.jobId(req);
        const job = await jobService.cancelJob(req.params.id, req.context);
        return res.status(202).json(new Response(true, `Job is ${job.status}.`, job, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** POST /jobs/:id/retry */
const retry = async (req, res, next) => {
    try {
        await validator.jobId(req);
        const job = await jobService.retryJob(req.params.id, req.context);
        return res.status(202).json(new Response(true, 'Job re-queued.', job, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** POST /jobs/:id/stream-token */
const streamToken = async (req, res, next) => {
    try {
        await validator.jobId(req);
        const token = await jobService.createStreamToken(req.params.id, req.context);
        return res.status(201).json(new Response(true, 'Stream token issued.', token, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /jobs/:id/artifacts */
const artifacts = async (req, res, next) => {
    try {
        await validator.jobId(req);
        const items = await jobService.listArtifacts(req.params.id, req.context);
        return res.json(new Response(true, 'Artifacts.', { items }, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /artifacts/:id — streams the file */
const download = async (req, res, next) => {
    try {
        await validator.artifactId(req);
        const artifact = await jobService.getArtifactFile(req.params.id, req.context);
        res.set({
            'Content-Type': artifact.mime || 'application/octet-stream',
            'Content-Length': String(artifact.size),
            'Content-Disposition': `attachment; filename="${artifact.name.replace(/["\\/]/g, '_')}"`,
            'X-Content-Type-Options': 'nosniff',
        });
        return fs.createReadStream(artifact.path).on('error', next).pipe(res);
    } catch (error) {
        return next(error);
    }
};

module.exports = { submit, list, get, result, events, cancel, retry, streamToken, artifacts, download };
