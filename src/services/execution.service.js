'use strict';

const config = require('../../config');

const jobRepository = require('../repositories/job.repository');
const jobAttemptRepository = require('../repositories/jobAttempt.repository');
const jobEventRepository = require('../repositories/jobEvent.repository');
const artifactRepository = require('../repositories/artifact.repository');
const appRepository = require('../repositories/app.repository');
const appUsageDailyRepository = require('../repositories/appUsageDaily.repository');
const webhookDeliveryRepository = require('../repositories/webhookDelivery.repository');
const skillRepository = require('../repositories/skill.repository');
const sessionService = require('./session.service');
const providerStateService = require('./providerState.service');
const { writeStatusEvent } = require('./job.service');
const { isFeatureEnabled } = require('./app.service');
const { canStart, DEFERRABLE } = require('./schedulingPolicy.service');
const { decideAfterFailure, ACTION } = require('./retryPolicy.service');
const { budgetDay } = require('./usage.service');
const notifyHub = require('../infra/notifyHub');
const { withTransaction } = require('../utils/transaction');
const { validateSchema } = require('../utils/jsonSchema');
const { backoffSec } = require('../utils/backoff');
const getLogger = require('../utils/logger');
const { JOB_STATUS, ACTIVE_STATUSES, isTerminal, sourcesOf } = require('../constants/jobStatus');
const { CHANNELS } = require('../constants/eventTypes');
const { ERROR_CLASS } = require('../constants/errorClasses');
const { ATTEMPT_MODE, CHANGE_MODE } = require('../constants/skill');
const { DELIVERY_STATUS } = require('../constants/delivery');
const { FEATURES } = require('../constants/features');
const { LIMIT_SCOPE, modelFamily } = require('../constants/provider');

const logger = getLogger(__filename);

const LIMITS = Object.freeze({
    concurrency: config.get('worker.concurrency'),
    longSlots: config.get('worker.longJobSlots'),
});
const THRESHOLDS = Object.freeze({
    quick: config.get('usage.quickJobMaxUtilization'),
    long: config.get('usage.longJobMaxUtilization'),
});
const LEASE_SEC = config.get('worker.leaseSec');
const CLAIM_BATCH = config.get('worker.claimBatch');
const MAX_AUTO_RETRIES = config.get('job.maxAutoRetries');
const RETRY_BASE_SEC = config.get('job.retryBaseDelaySec');
const RETRY_MAX_SEC = config.get('job.retryMaxDelaySec');

const leaseUntil = () => new Date(Date.now() + LEASE_SEC * 1000);

const publishJobEvent = (job) =>
    notifyHub.publish(CHANNELS.JOB_EVENTS, { jobId: job.id, appId: job.appId }).catch(() => {});

const failQueued = async (job, errorCode, errorMessage, transaction) => {
    const updated = await jobRepository.transitionInternal(
        job.id,
        [JOB_STATUS.QUEUED],
        { status: JOB_STATUS.FAILED, errorCode, errorMessage, finishedAt: new Date() },
        { transaction },
    );
    if (updated) await writeStatusEvent(updated, `failed: ${errorMessage}`, { transaction });
    return updated;
};

const checkSkillStillValid = async (job, transaction) => {
    const skill = await skillRepository.findByName(job.skillName, { transaction });
    if (!skill || !skill.enabled) {
        await failQueued(job, 'SKILL_DISABLED', `Skill '${job.skillName}' is no longer available.`, transaction);
        return null;
    }
    const { valid } = validateSchema(skill.manifest.inputSchema, job.input);
    if (!valid) {
        await failQueued(
            job,
            'INPUT_INVALID_FOR_VERSION',
            `Input no longer matches skill ${skill.name}@${skill.version}.`,
            transaction,
        );
        return null;
    }
    return skill;
};

const loadClaimContext = async (candidates, transaction) => {
    const appIds = [...new Set(candidates.map((j) => j.appId))];
    // sequential on purpose: a transaction owns one connection, which must not run concurrent queries
    const apps = await appRepository.findByIdsInternal(appIds, { transaction });
    const active = await jobRepository.countActiveInternal({ transaction });
    const scheduling = await providerStateService.getSchedulingState({ transaction });
    return { appsById: Object.fromEntries(apps.map((a) => [a.id, a])), active, scheduling };
};

const policyFor = async (job, app, skill, { active, scheduling }) => {
    const used = app.dailyTokenBudget
        ? await appUsageDailyRepository.getTokens(app.id, budgetDay(new Date(), app.timezone))
        : 0;
    return canStart({
        job,
        app,
        manifest: skill.manifest,
        active,
        limits: LIMITS,
        pauses: scheduling.pauses,
        usage: scheduling.usage,
        thresholds: THRESHOLDS,
        budget: { used },
        now: new Date(),
    });
};

const takeJob = async ({ job, app, skill, hostId, runtime }, transaction) => {
    if (job.sessionId && !(await sessionService.acquireLock(job.sessionId, job.id, { transaction }))) return null;
    const claimed = await jobRepository.transitionInternal(
        job.id,
        [JOB_STATUS.QUEUED],
        {
            status: JOB_STATUS.CLAIMED,
            leaseOwner: hostId,
            leaseExpiresAt: leaseUntil(),
            attemptCount: job.attemptCount + 1,
            cancelRequested: false,
        },
        { transaction },
    );
    if (!claimed) return null;
    const attempt = await jobAttemptRepository.create(
        {
            jobId: job.id,
            appId: job.appId,
            n: claimed.attemptCount,
            skillVersion: skill.version,
            skillChecksum: skill.checksum,
            manifest: skill.manifest,
            model: job.model,
            mode: job.nextAttemptMode,
            runtime,
            hostId,
        },
        { transaction },
    );
    await writeStatusEvent(claimed, `claimed (attempt ${attempt.n}, ${attempt.mode})`, { transaction });
    return { job: { ...claimed, input: job.input }, attempt, skill, app };
};

const tryClaimCandidate = async (job, ctx, claimArgs, transaction) => {
    const skill = await checkSkillStillValid(job, transaction);
    const app = ctx.appsById[job.appId];
    if (!skill || !app) return null;
    const decision = await policyFor(job, app, skill, ctx);
    if (!decision.ok) {
        if (DEFERRABLE.includes(decision.reason) && decision.retryAt)
            await jobRepository.deferInternal(job.id, decision.retryAt, { transaction });
        return null;
    }
    return takeJob({ job, app, skill, ...claimArgs }, transaction);
};

/**
 * Claim the next startable job (architecture §4 Claim). Returns null when nothing can start.
 * @param {{hostId: string, runtime: string}} claimArgs
 * @returns {Promise<{job: Object, attempt: Object, skill: Object, app: Object}|null>}
 */
const claimNextJob = async (claimArgs) => {
    const claimed = await withTransaction('execution.claim', async (transaction) => {
        const excludeSessionIds = await sessionService.lockedSessionIds({ transaction });
        const candidates = await jobRepository.lockClaimCandidatesInternal(
            { limit: CLAIM_BATCH, excludeSessionIds },
            { transaction },
        );
        if (!candidates.length) return null;
        const ctx = await loadClaimContext(candidates, transaction);
        for (const job of candidates) {
            const result = await tryClaimCandidate(job, ctx, claimArgs, transaction);
            if (result) return result;
        }
        return null;
    });
    if (claimed) await publishJobEvent(claimed.job);
    return claimed;
};

const transitionWithEvent = async (jobId, from, fields, summary) => {
    const updated = await withTransaction('execution.transition', async (transaction) => {
        const row = await jobRepository.transitionInternal(jobId, from, fields, { transaction });
        if (row) await writeStatusEvent(row, summary, { transaction });
        return row;
    });
    if (updated) await publishJobEvent(updated);
    return updated;
};

/**
 * claimed → provisioning (workspace and repo preparation starts).
 * @param {Object} job
 * @returns {Promise<Object|null>} null when the job changed state (e.g. cancel requested)
 */
const markProvisioning = (job) =>
    transitionWithEvent(job.id, [JOB_STATUS.CLAIMED], { status: JOB_STATUS.PROVISIONING }, JOB_STATUS.PROVISIONING);

/**
 * provisioning → running, recording the runner handle and workspace on the attempt.
 * @param {Object} job
 * @param {Object} attempt
 * @param {{handle: Object, workspacePath: string}} started
 * @returns {Promise<Object|null>}
 */
const markRunning = async (job, attempt, { handle, workspacePath }) => {
    await jobAttemptRepository.update(attempt.id, { runtimeHandle: handle, workspacePath, startedAt: new Date() });
    return transitionWithEvent(
        job.id,
        [JOB_STATUS.PROVISIONING],
        { status: JOB_STATUS.RUNNING, startedAt: job.startedAt || new Date() },
        JOB_STATUS.RUNNING,
    );
};

/**
 * Persist a batch of stream events and the attempt's progress counters (idempotent on replay).
 * @param {Object} attempt
 * @param {{events: Object[], streamOffset: number, streamSeq: number, fields: Object}} batch
 * @returns {Promise<void>}
 */
const recordProgress = async (attempt, { events, streamOffset, streamSeq, fields }) => {
    await withTransaction('execution.progress', async (transaction) => {
        await jobEventRepository.bulkInsert(
            events.map((e) => ({ ...e, jobId: attempt.jobId, appId: attempt.appId, attemptId: attempt.id })),
            { transaction },
        );
        await jobAttemptRepository.update(attempt.id, { streamOffset, streamSeq, ...fields }, { transaction });
    });
    if (events.length) await publishJobEvent({ id: attempt.jobId, appId: attempt.appId });
};

/**
 * Extend leases for jobs this host is running.
 * @param {string} hostId
 * @param {string[]} jobIds
 * @returns {Promise<number>}
 */
const renewLeases = (hostId, jobIds) => jobRepository.renewLeasesInternal(jobIds, hostId, leaseUntil());

/**
 * Current status and cancel flag for this host's active jobs.
 * @param {string} hostId
 * @returns {Promise<Object[]>}
 */
const activeJobsForHost = (hostId) => jobRepository.findActiveByHostInternal(hostId);

const attemptFields = (outcome, run) => ({
    finishedAt: new Date(),
    // the final, settled flags (calls cut off by a crash count) are what the retry decision used: persist them
    startedActing: Boolean(run.startedActing),
    actedOutsideWorkspace: Boolean(run.actedOutsideWorkspace),
    exitCode: run.exit ? run.exit.code : null,
    signal: run.exit ? run.exit.signal || null : null,
    subtype: run.result ? run.result.subtype : null,
    terminalReason: run.result ? run.result.terminal_reason || null : null,
    numTurns: run.result ? run.result.num_turns : null,
    usage: run.result ? run.result.usage || null : null,
    modelUsage: run.result ? run.result.modelUsage || null : null,
    claudeSessionId: run.claudeSessionId || null,
    tokenCount: run.tokenCount,
    errorClass: outcome.errorClass,
    errorMessage: outcome.message,
});

const terminalSideEffects = async (job, { artifacts, claudeSessionId }, transaction) => {
    if (artifacts.length)
        await artifactRepository.bulkCreate(
            artifacts.map((a) => ({ ...a, jobId: job.id, appId: job.appId })),
            { transaction },
        );
    if (job.webhookUrl) await webhookDeliveryRepository.create({ jobId: job.id, appId: job.appId }, { transaction });
    if (job.sessionId) {
        if (claudeSessionId) await sessionService.recordClaudeSession(job.sessionId, claudeSessionId, { transaction });
        await sessionService.releaseLock(job.sessionId, job.id, { transaction });
    }
};

const finishFields = (status, outcome, extra = {}) => ({
    status,
    finishedAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: outcome.errorClass ? outcome.errorClass.toUpperCase() : null,
    errorMessage: outcome.message,
    ...extra,
});

const limitPauseUntil = async (job) => {
    const { usage } = await providerStateService.getSchedulingState();
    const windowReset = usage && usage.resetsAt ? new Date(usage.resetsAt) : null;
    const scope =
        usage && usage.rateLimitType && /opus|sonnet|haiku/i.test(usage.rateLimitType)
            ? LIMIT_SCOPE.model(modelFamily(job.model))
            : LIMIT_SCOPE.GLOBAL;
    return providerStateService.pauseScope(scope, windowReset, 'plan limit reached');
};

const decide = (job, attempt, outcome, run) =>
    decideAfterFailure({
        errorClass: outcome.errorClass,
        startedActing: run.startedActing,
        actedOutsideWorkspace: run.actedOutsideWorkspace,
        canResume: run.canResume,
        rerunSafe: Boolean(attempt.manifest.rerunSafe),
        autoRetriesUsed: job.autoRetries,
        maxAutoRetries: MAX_AUTO_RETRIES,
        attemptsMade: job.attemptCount,
        cancelRequested: job.cancelRequested || job.status === JOB_STATUS.CANCELLING,
    });

const requeueFields = (job, attempt, decision, runAfter) => ({
    status: decision.action === ACTION.WAIT_LIMIT ? JOB_STATUS.WAITING_LIMIT : JOB_STATUS.QUEUED,
    nextAttemptMode: decision.mode,
    resumeAttemptId: decision.mode === ATTEMPT_MODE.RESUME ? attempt.id : null,
    autoRetries: job.autoRetries + (decision.counted ? 1 : 0),
    runAfter,
    leaseOwner: null,
    leaseExpiresAt: null,
});

/** Delivery will follow success, so the job is marked pending in the same transaction (no race for clients). */
const deliveryPlanned = (job, attempt, app) =>
    Boolean(job.repoUrl) &&
    attempt.manifest.changes !== CHANGE_MODE.NONE &&
    isFeatureEnabled(app, FEATURES.CHANGE_DELIVERY);

const planFinalize = async ({ job, attempt, app }, outcome, run) => {
    if (outcome.succeeded && job.status !== JOB_STATUS.CANCELLING) {
        const delivery = deliveryPlanned(job, attempt, app) ? { deliveryStatus: DELIVERY_STATUS.PENDING } : {};
        return {
            status: JOB_STATUS.SUCCEEDED,
            fields: finishFields(JOB_STATUS.SUCCEEDED, outcome, { result: run.output, ...delivery }),
        };
    }
    const decision = decide(job, attempt, outcome, run);
    if (decision.action === ACTION.FINISH) {
        return {
            status: decision.status,
            decision,
            fields: finishFields(decision.status, outcome, { possiblyPartial: Boolean(decision.possiblyPartial) }),
        };
    }
    const runAfter =
        decision.action === ACTION.WAIT_LIMIT
            ? await limitPauseUntil(job)
            : new Date(
                  Date.now() +
                      backoffSec(job.autoRetries + 1, { baseSec: RETRY_BASE_SEC, maxSec: RETRY_MAX_SEC }) * 1000,
              );
    return { status: decision.action, decision, fields: requeueFields(job, attempt, decision, runAfter) };
};

const statusSummary = (plan, outcome) => {
    if (plan.status === JOB_STATUS.SUCCEEDED) return JOB_STATUS.SUCCEEDED;
    const reason = outcome.errorClass ? ` (${outcome.errorClass})` : '';
    if (plan.decision && plan.decision.action !== ACTION.FINISH)
        return `${plan.fields.status}: retry as ${plan.decision.mode}${reason}`;
    return `${plan.status}${reason}`;
};

/**
 * Close an attempt and move the job on: succeed, retry (fresh or resume), wait for a plan limit, or finish.
 * @param {{job: Object, attempt: Object}} ctx
 * @param {Object} outcome classifyOutcome() result
 * @param {Object} run { exit, result, output, artifacts, startedActing, actedOutsideWorkspace, canResume, claudeSessionId, tokenCount }
 * @returns {Promise<{status: string, job: Object|null}>}
 */
const finalizeAttempt = async ({ attempt }, outcome, run) => {
    const job = await jobRepository.findByIdInternal(attempt.jobId);
    if (!job || isTerminal(job.status)) {
        await jobAttemptRepository.update(attempt.id, attemptFields(outcome, run));
        return { status: job ? job.status : null, job };
    }
    const app = await appRepository.findByIdInternal(job.appId);
    const plan = await planFinalize({ job, attempt, app }, outcome, run);
    const updated = await withTransaction('execution.finalize', async (transaction) => {
        await jobAttemptRepository.update(attempt.id, attemptFields(outcome, run), { transaction });
        if (app && run.tokenCount)
            await appUsageDailyRepository.addTokens(app.id, budgetDay(new Date(), app.timezone), run.tokenCount, {
                transaction,
            });
        const from = sourcesOf(plan.fields.status).filter((st) => ACTIVE_STATUSES.includes(st));
        const row = await jobRepository.transitionInternal(job.id, from, plan.fields, { transaction });
        if (!row) return null;
        await writeStatusEvent(row, statusSummary(plan, outcome), { transaction });
        if (isTerminal(row.status)) await terminalSideEffects(row, run, transaction);
        else if (row.sessionId) await sessionService.releaseLock(row.sessionId, row.id, { transaction });
        return row;
    });
    if (!updated) {
        const current = await jobRepository.findByIdInternal(job.id);
        if (current && current.status === job.status) {
            throw new Error(`Illegal transition ${job.status} → ${plan.fields.status} for job ${job.id}`);
        }
        return finalizeAttempt({ attempt }, outcome, run);
    }
    await publishJobEvent(updated);
    if (updated.status === JOB_STATUS.QUEUED)
        await notifyHub.publish(CHANNELS.JOB_QUEUED, { jobId: updated.id }).catch(() => {});
    logger.info(
        `Attempt finished ${JSON.stringify({ jobId: job.id, attempt: attempt.n, status: updated.status, errorClass: outcome.errorClass, tokenCount: run.tokenCount })}`,
    );
    return { status: updated.status, job: updated };
};

/** Run record for an attempt in which Claude never ran (nothing acted, no output). */
const EMPTY_RUN = Object.freeze({
    exit: null,
    result: null,
    output: null,
    artifacts: [],
    startedActing: false,
    actedOutsideWorkspace: false,
    canResume: false,
    tokenCount: 0,
});

/**
 * End an attempt that never started Claude (launch failed, cancelled first, worker restarted early).
 * The retry policy decides: infra failures retry (bounded), validation failures finish.
 * @param {Object} attempt
 * @param {string} message
 * @param {string} [errorClass]
 * @returns {Promise<{status: string, job: Object|null}>}
 */
const abandonBeforeStart = (attempt, message, errorClass = ERROR_CLASS.GATEWAY) =>
    finalizeAttempt({ attempt }, { succeeded: false, errorClass, message: String(message).slice(0, 500) }, EMPTY_RUN);

/**
 * Open attempts this host owns (re-attach after a worker restart).
 * @param {string} hostId
 * @returns {Promise<Array<{job: Object, attempt: Object}>>}
 */
const openAttemptsForHost = async (hostId) => {
    const attempts = await jobAttemptRepository.findOpenByHostInternal(hostId);
    const pairs = await Promise.all(
        attempts.map(async (attempt) => ({ attempt, job: await jobRepository.findByIdInternal(attempt.jobId) })),
    );
    return pairs.filter((p) => p.job);
};

/**
 * Plan-limit waits whose pause ended go back to the queue.
 * @returns {Promise<number>}
 */
const releaseWaitingLimitJobs = () => jobRepository.requeueWaitingLimitInternal(new Date());

/**
 * Jobs with expired leases owned by other hosts (crashed worker) — finalized as crashes.
 * @param {string} hostId
 * @returns {Promise<Array<{job: Object, attempt: Object}>>}
 */
const expiredForeignAttempts = async (hostId) => {
    const expired = (await jobRepository.findExpiredLeasesInternal(new Date())).filter((j) => j.leaseOwner !== hostId);
    const pairs = await Promise.all(
        expired.map(async (j) => ({
            job: await jobRepository.findByIdInternal(j.id),
            attempt: await jobAttemptRepository.findLatestForJobInternal(j.id),
        })),
    );
    return pairs.filter((p) => p.job && p.attempt);
};

/**
 * @param {string} appId
 * @returns {Promise<Object|null>}
 */
const getAppInternal = (appId) => appRepository.findByIdInternal(appId);

/**
 * @param {string} attemptId
 * @returns {Promise<Object|null>}
 */
const getAttemptInternal = (attemptId) => jobAttemptRepository.findByIdInternal(attemptId);

/**
 * @param {string} jobId
 * @returns {Promise<Object|null>}
 */
const latestAttemptInternal = (jobId) => jobAttemptRepository.findLatestForJobInternal(jobId);

/**
 * Weighted tokens the app has used today (budget baseline for in-flight checks).
 * @param {{id: string, timezone: string}} app
 * @returns {Promise<number>}
 */
const budgetUsedToday = (app) => appUsageDailyRepository.getTokens(app.id, budgetDay(new Date(), app.timezone));

module.exports = {
    getAppInternal,
    getAttemptInternal,
    latestAttemptInternal,
    budgetUsedToday,
    claimNextJob,
    markProvisioning,
    markRunning,
    recordProgress,
    renewLeases,
    activeJobsForHost,
    finalizeAttempt,
    abandonBeforeStart,
    EMPTY_RUN,
    openAttemptsForHost,
    releaseWaitingLimitJobs,
    expiredForeignAttempts,
};
