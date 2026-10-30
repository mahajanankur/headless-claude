'use strict';

const config = require('../../config');

const jobRepository = require('../repositories/job.repository');
const jobAttemptRepository = require('../repositories/jobAttempt.repository');
const jobEventRepository = require('../repositories/jobEvent.repository');
const artifactRepository = require('../repositories/artifact.repository');
const appUsageDailyRepository = require('../repositories/appUsageDaily.repository');
const skillService = require('./skill.service');
const sessionService = require('./session.service');
const providerStateService = require('./providerState.service');
const { recordAudit } = require('./audit.service');
const { isFeatureEnabled } = require('./app.service');
const { issueStreamToken } = require('./streamToken.service');
const jobRequest = require('./jobRequest.service');
const { budgetDay, nextBudgetReset } = require('./usage.service');
const notifyHub = require('../infra/notifyHub');
const { withTransaction } = require('../utils/transaction');
const { sha256, stableStringify } = require('../utils/hash');
const { assertSafeOutboundUrl } = require('../utils/netGuard');
const {
    ConflictError,
    ForbiddenError,
    NotFoundError,
    QuotaExceededError,
    UpstreamError,
    ValidationError,
    mapDbError,
} = require('../utils/AppError');
const { JOB_STATUS, TERMINAL_STATUSES, ACTIVE_STATUSES, isTerminal } = require('../constants/jobStatus');
const { EVENT_TYPE, CHANNELS } = require('../constants/eventTypes');
const { FEATURES } = require('../constants/features');
const { API_ERROR } = require('../constants/apiErrors');
const { AUDIT_ACTION } = require('../constants/audit');
const { ATTEMPT_MODE } = require('../constants/skill');

const PRIORITY = Object.freeze({ low: 0, normal: 1, high: 2 });
const PRIORITY_NAME = Object.freeze(Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [v, k])));
const MAX_PAGE = config.get('pagination.maxLimit');
const DEFAULT_PAGE = config.get('pagination.defaultLimit');
const ALLOW_PRIVATE_WEBHOOKS = config.get('webhook.allowPrivateHosts');
const RETRYABLE_BY_CALLER = Object.freeze([JOB_STATUS.FAILED, JOB_STATUS.NEEDS_REVIEW, JOB_STATUS.TIMED_OUT]);

const notFound = () => new NotFoundError('Job not found.', API_ERROR.JOB_NOT_FOUND);

const toPublicAttempt = (a) => ({
    n: a.n,
    mode: a.mode,
    skillVersion: a.skillVersion,
    model: a.model,
    subtype: a.subtype,
    terminalReason: a.terminalReason,
    errorClass: a.errorClass,
    numTurns: a.numTurns,
    tokenCount: Number(a.tokenCount || 0),
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
});

/**
 * Public job shape (never internal paths, leases or input).
 * @param {Object} job
 * @param {Object[]} [attempts]
 * @returns {Object}
 */
const toPublicJob = (job, attempts) => ({
    jobId: job.id,
    status: job.status,
    skill: job.skillName,
    model: job.model,
    priority: PRIORITY_NAME[job.priority],
    urgent: job.urgent,
    runAfter: job.runAfter,
    sessionId: job.sessionId,
    attemptCount: job.attemptCount,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    possiblyPartial: job.possiblyPartial,
    delivery: job.deliveryStatus
        ? { status: job.deliveryStatus, error: job.deliveryError, branch: job.branch, prUrl: job.prUrl }
        : null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(attempts ? { attempts: attempts.map(toPublicAttempt) } : {}),
});

const statusEvent = (job, summary) => ({
    jobId: job.id,
    appId: job.appId,
    attemptId: null,
    seq: job.statusSeq,
    type: EVENT_TYPE.STATUS,
    summary: summary || job.status,
});

/**
 * Write a status event for a job row returned by transitionInternal (same transaction).
 * @param {Object} job
 * @param {string} [summary]
 * @param {{transaction?: Object}} [options]
 * @returns {Promise<void>}
 */
const writeStatusEvent = (job, summary, { transaction } = {}) =>
    jobEventRepository.bulkInsert([statusEvent(job, summary)], { transaction });

const checkIntake = async (app) => {
    if (app.intakePaused) throw new UpstreamError('Job intake is paused for this app.', null, API_ERROR.INTAKE_PAUSED);
    const { pauses } = await providerStateService.getSchedulingState();
    if (pauses.intake && new Date(pauses.intake) > new Date()) {
        throw new UpstreamError('Job intake is paused.', null, API_ERROR.INTAKE_PAUSED);
    }
};

const checkBudget = async (app) => {
    if (!app.dailyTokenBudget) return;
    const now = new Date();
    const used = await appUsageDailyRepository.getTokens(app.id, budgetDay(now, app.timezone));
    if (used >= Number(app.dailyTokenBudget)) {
        const resetsAt = nextBudgetReset(now, app.timezone);
        throw new QuotaExceededError('Daily token budget exhausted for this app.', {
            resetsAt: resetsAt.toISOString(),
        });
    }
};

const resolveWebhook = async (app, webhookUrl) => {
    if (!webhookUrl) return null;
    if (!isFeatureEnabled(app, FEATURES.WEBHOOKS))
        throw new ValidationError('Webhooks (webhookUrl) are not enabled for this app.');
    try {
        await assertSafeOutboundUrl(webhookUrl, {
            allowedHosts: app.webhookAllowedHosts,
            allowPrivate: ALLOW_PRIVATE_WEBHOOKS,
        });
    } catch (error) {
        throw new ValidationError(`Webhook (webhookUrl) rejected: ${error.message}`);
    }
    return webhookUrl;
};

const resolveSkillForApp = async (app, skillName) => {
    if (!app.allowedSkills.includes(skillName)) {
        throw new ForbiddenError(`This app may not use skill '${skillName}'.`, API_ERROR.FORBIDDEN_SKILL);
    }
    return skillService.resolveSkill(skillName);
};

const buildJobRow = async (body, context, skill, options = {}) => {
    const { app } = context;
    const { manifest } = skill;
    jobRequest.validateInput(body.input, manifest);
    const model = jobRequest.resolveModel(body.model, manifest, app);
    const timeoutSec = jobRequest.resolveTimeout(body.timeoutSec, manifest);
    const { repoUrl, repoRef } = jobRequest.resolveRepo(body.input, manifest);
    if (body.urgent && !context.isAdmin) throw new ForbiddenError('Only admin apps may submit urgent jobs (urgent).');
    const sessionId = await sessionService.resolveForSubmit(body, context, manifest, {
        featureChecked: Boolean(options.sessionFeatureChecked),
    });
    return {
        appId: app.id,
        apiKeyId: context.keyId,
        skillName: skill.name,
        skillClass: manifest.class,
        model,
        input: body.input,
        inputHash: sha256(
            stableStringify({ skill: skill.name, input: body.input, model, sessionId, repoUrl, repoRef }),
        ),
        priority: PRIORITY[body.priority || 'normal'],
        urgent: Boolean(body.urgent),
        runAfter: body.runAfter ? new Date(body.runAfter) : null,
        timeoutSec,
        sessionId,
        continueFromJobId: body.continueFromJobId || null,
        webhookUrl: await resolveWebhook(app, body.webhookUrl),
        repoUrl,
        repoRef,
    };
};

const findIdempotent = async (appId, idempotencyKey, inputHash) => {
    const existing = await jobRepository.findByIdempotencyKey(appId, idempotencyKey);
    if (!existing) return null;
    if (existing.inputHash !== inputHash) {
        throw new ConflictError(
            'Idempotency-Key was already used with a different request.',
            API_ERROR.IDEMPOTENCY_CONFLICT,
        );
    }
    return existing;
};

const insertJob = async (row) => {
    try {
        return await withTransaction('job.submit', async (transaction) => {
            const job = await jobRepository.create({ ...row, statusSeq: 1 }, { transaction });
            await writeStatusEvent(job, JOB_STATUS.QUEUED, { transaction });
            return job;
        });
    } catch (error) {
        const mapped = mapDbError(error);
        if (mapped instanceof ConflictError && row.idempotencyKey) {
            return findIdempotent(row.appId, row.idempotencyKey, row.inputHash);
        }
        throw mapped;
    }
};

/**
 * Validate, authorise and enqueue a job (architecture §4 Submit).
 * @param {Object} body validated request body
 * @param {Object} context req.context
 * @param {{idempotencyKey?: string, sessionFeatureChecked?: boolean}} [options]
 * @returns {Promise<{job: Object, created: boolean}>}
 */
const submitJob = async (body, context, { idempotencyKey, sessionFeatureChecked = false } = {}) => {
    const { app } = context;
    await checkIntake(app);
    const skill = await resolveSkillForApp(app, body.skill);
    const row = {
        ...(await buildJobRow(body, context, skill, { sessionFeatureChecked })),
        idempotencyKey: idempotencyKey || null,
    };
    if (idempotencyKey) {
        const existing = await findIdempotent(app.id, idempotencyKey, row.inputHash);
        if (existing) return { job: toPublicJob(existing), created: false };
    }
    await checkBudget(app);
    const job = await insertJob(row);
    await notifyHub.publish(CHANNELS.JOB_QUEUED, { jobId: job.id });
    await notifyHub.publish(CHANNELS.JOB_EVENTS, { jobId: job.id, appId: app.id });
    return { job: toPublicJob(job), created: true };
};

/**
 * @param {string} jobId
 * @param {Object} context
 * @returns {Promise<Object>}
 * @throws {NotFoundError}
 */
const getJob = async (jobId, context) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!job) throw notFound();
    const attempts = await jobAttemptRepository.listForJob(jobId, context.appId);
    return toPublicJob(job, attempts);
};

const encodeCursor = (job) => Buffer.from(`${new Date(job.createdAt).toISOString()}|${job.id}`).toString('base64url');

const decodeCursor = (cursor) => {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const date = new Date(createdAt);
    if (!id || Number.isNaN(date.getTime())) throw new ValidationError('Cursor (cursor) is not valid.');
    return { createdAt: date, id };
};

/**
 * @param {Object} context
 * @param {{limit?: number, cursor?: string, status?: string}} query
 * @returns {Promise<{items: Object[], nextCursor: string|null}>}
 */
const listJobs = async (context, { limit = DEFAULT_PAGE, cursor, status } = {}) => {
    const pageSize = Math.min(limit, MAX_PAGE);
    const before = cursor ? decodeCursor(cursor) : undefined;
    const rows = await jobRepository.listForApp(context.appId, { limit: pageSize + 1, before, status });
    const page = rows.slice(0, pageSize);
    return {
        items: page.map((j) => toPublicJob(j)),
        nextCursor: rows.length > pageSize ? encodeCursor(page[page.length - 1]) : null,
    };
};

/**
 * @param {string} jobId
 * @param {Object} context
 * @returns {Promise<{status: string, output: *, artifacts: Object[]}>}
 * @throws {NotFoundError|ConflictError}
 */
const getJobResult = async (jobId, context) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId, { withResult: true });
    if (!job) throw notFound();
    if (!isTerminal(job.status))
        throw new ConflictError(`Job is ${job.status}; no result yet.`, API_ERROR.INVALID_STATE);
    const artifacts = await artifactRepository.listForJob(jobId, context.appId);
    return { jobId, status: job.status, output: job.result, error: toPublicJob(job).error, artifacts };
};

/**
 * @param {string} jobId
 * @param {Object} context
 * @param {{after?: number, limit?: number}} query
 * @returns {Promise<{items: Object[], nextAfter: number|null}>}
 */
const listJobEvents = async (jobId, context, { after = 0, limit = DEFAULT_PAGE } = {}) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!job) throw notFound();
    const items = await jobEventRepository.listForJob(jobId, context.appId, {
        afterId: after,
        limit: Math.min(limit, MAX_PAGE),
    });
    return { items, nextAfter: items.length ? Number(items[items.length - 1].id) : null, status: job.status };
};

const cancelPending = (job, context) =>
    withTransaction('job.cancelPending', async (transaction) => {
        const updated = await jobRepository.transitionInternal(
            job.id,
            [JOB_STATUS.QUEUED, JOB_STATUS.WAITING_LIMIT],
            {
                status: JOB_STATUS.CANCELLED,
                finishedAt: new Date(),
                errorCode: 'CANCELLED',
                errorMessage: 'Cancelled by caller.',
            },
            { transaction, appId: context.appId },
        );
        if (!updated) return null;
        await writeStatusEvent(updated, JOB_STATUS.CANCELLED, { transaction });
        if (updated.sessionId) await sessionService.releaseLock(updated.sessionId, updated.id, { transaction });
        await recordAudit(
            { appId: context.appId, action: AUDIT_ACTION.JOB_CANCELLED, targetType: 'job', targetId: job.id },
            { transaction },
        );
        return updated;
    });

const cancelActive = (job, context) =>
    withTransaction('job.cancelActive', async (transaction) => {
        const updated = await jobRepository.transitionInternal(
            job.id,
            [JOB_STATUS.CLAIMED, JOB_STATUS.PROVISIONING, JOB_STATUS.RUNNING],
            { status: JOB_STATUS.CANCELLING, cancelRequested: true },
            { transaction, appId: context.appId },
        );
        if (!updated) return null;
        await writeStatusEvent(updated, JOB_STATUS.CANCELLING, { transaction });
        await recordAudit(
            { appId: context.appId, action: AUDIT_ACTION.JOB_CANCELLED, targetType: 'job', targetId: job.id },
            { transaction },
        );
        return updated;
    });

/**
 * Cancel a job. Queued → cancelled at once; running → cancelling (the worker stops it).
 * @param {string} jobId
 * @param {Object} context
 * @returns {Promise<Object>}
 * @throws {NotFoundError|ConflictError}
 */
const cancelJob = async (jobId, context) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!job) throw notFound();
    if (job.status === JOB_STATUS.CANCELLING) return toPublicJob(job);
    if (isTerminal(job.status)) throw new ConflictError(`Job already ${job.status}.`, API_ERROR.INVALID_STATE);
    const pending = [JOB_STATUS.QUEUED, JOB_STATUS.WAITING_LIMIT].includes(job.status);
    const updated = pending ? await cancelPending(job, context) : await cancelActive(job, context);
    if (!updated) return cancelJob(jobId, context);
    await notifyHub.publish(CHANNELS.JOB_EVENTS, { jobId, appId: context.appId });
    if (!pending) await notifyHub.publish(CHANNELS.JOB_CANCEL, { jobId });
    return toPublicJob(updated);
};

/**
 * Re-queue a finished, unsuccessful job as a fresh attempt.
 * @param {string} jobId
 * @param {Object} context
 * @returns {Promise<Object>}
 * @throws {NotFoundError|ConflictError}
 */
const retryJob = async (jobId, context) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!job) throw notFound();
    if (!RETRYABLE_BY_CALLER.includes(job.status)) {
        throw new ConflictError(`Only ${RETRYABLE_BY_CALLER.join(', ')} jobs can be retried.`, API_ERROR.INVALID_STATE);
    }
    const updated = await withTransaction('job.retry', async (transaction) => {
        const row = await jobRepository.transitionInternal(
            jobId,
            RETRYABLE_BY_CALLER,
            {
                status: JOB_STATUS.QUEUED,
                autoRetries: 0,
                nextAttemptMode: ATTEMPT_MODE.FRESH,
                resumeAttemptId: null,
                errorCode: null,
                errorMessage: null,
                possiblyPartial: false,
                finishedAt: null,
                runAfter: null,
                cancelRequested: false,
            },
            { transaction, appId: context.appId },
        );
        if (!row) throw new ConflictError('Job changed state; try again.', API_ERROR.INVALID_STATE);
        await writeStatusEvent(row, 'queued (manual retry)', { transaction });
        await recordAudit(
            { appId: context.appId, action: AUDIT_ACTION.JOB_RETRIED, targetType: 'job', targetId: jobId },
            { transaction },
        );
        return row;
    });
    await notifyHub.publish(CHANNELS.JOB_QUEUED, { jobId });
    await notifyHub.publish(CHANNELS.JOB_EVENTS, { jobId, appId: context.appId });
    return toPublicJob(updated);
};

/**
 * @param {string} jobId
 * @param {Object} context
 * @returns {Promise<Object[]>}
 */
const listArtifacts = async (jobId, context) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!job) throw notFound();
    return artifactRepository.listForJob(jobId, context.appId);
};

/**
 * Artifact metadata including the on-disk path (for streaming the download).
 * @param {string} artifactId
 * @param {Object} context
 * @returns {Promise<Object>}
 * @throws {NotFoundError}
 */
const getArtifactFile = async (artifactId, context) => {
    const artifact = await artifactRepository.findByIdForApp(artifactId, context.appId);
    if (!artifact) throw new NotFoundError('Artifact not found.', API_ERROR.ARTIFACT_NOT_FOUND);
    return artifact;
};

/**
 * @param {string} jobId
 * @param {Object} context
 * @returns {Promise<{token: string, expiresIn: number}>}
 */
const createStreamToken = async (jobId, context) => {
    const job = await jobRepository.findByIdForApp(jobId, context.appId);
    if (!job) throw notFound();
    return issueStreamToken({ jobId, appId: context.appId });
};

/**
 * Resolve when the job reaches a terminal state or the timeout passes (for ?wait=).
 * @param {string} jobId
 * @param {string} appId
 * @param {number} timeoutMs
 * @returns {Promise<string>} the last observed status
 */
const waitForTerminal = (jobId, appId, timeoutMs) =>
    new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const done = (status) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            notifyHub.removeListener(CHANNELS.JOB_EVENTS, onEvent);
            resolve(status);
        };
        const check = async () => {
            const job = await jobRepository.findByIdForApp(jobId, appId);
            if (!job || TERMINAL_STATUSES.includes(job.status)) done(job ? job.status : null);
            return job;
        };
        const onEvent = (payload) => {
            if (payload.jobId === jobId) check().catch(() => {});
        };
        notifyHub.on(CHANNELS.JOB_EVENTS, onEvent);
        timer = setTimeout(async () => done((await check().catch(() => null))?.status || null), timeoutMs);
        check().catch(() => done(null));
    });

/**
 * Is a job not yet started and not startable right now? (?wait returns 202 immediately then.)
 * @param {Object} job public job
 * @returns {boolean}
 */
const isWaitPointless = (job) =>
    job.status === JOB_STATUS.WAITING_LIMIT || (job.runAfter && new Date(job.runAfter) > new Date());

/**
 * Admin kill-switch: pause an app's intake and cancel its queued and running jobs.
 * @param {string} appId
 * @param {Object} adminContext
 * @returns {Promise<{cancelledQueued: number, cancellingActive: number}>}
 */
const cancelAllForApp = async (appId, adminContext) => {
    const context = { ...adminContext, appId };
    const pending = await jobRepository.findPendingIdsForApp(appId);
    const active = await jobRepository.findActiveIdsForApp(appId);
    for (const id of [...pending, ...active]) {
        await cancelJob(id, context).catch(() => {});
    }
    await recordAudit({
        appId,
        action: AUDIT_ACTION.APP_JOBS_CANCELLED,
        details: { pending: pending.length, active: active.length },
    });
    return { cancelledQueued: pending.length, cancellingActive: active.length };
};

module.exports = {
    submitJob,
    getJob,
    listJobs,
    getJobResult,
    listJobEvents,
    cancelJob,
    retryJob,
    listArtifacts,
    getArtifactFile,
    createStreamToken,
    waitForTerminal,
    isWaitPointless,
    cancelAllForApp,
    toPublicJob,
    writeStatusEvent,
    PRIORITY,
    ACTIVE_STATUSES,
};
