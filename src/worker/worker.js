'use strict';

const fs = require('fs');

const config = require('../../config');
const { HOST } = require('../../config/paths');

const executionService = require('../services/execution.service');
const providerStateService = require('../services/providerState.service');
const skillService = require('../services/skill.service');
const webhookService = require('../services/webhook.service');
const { applyRetention } = require('../services/retention.service');
const deliveryService = require('../services/delivery.service');
const { classifyOutcome } = require('../services/outcome.service');
const notifyHub = require('../infra/notifyHub');
const { shutdownTracing } = require('../infra/langfuse');
const { AdvisoryLock } = require('../infra/advisoryLock');
const { AttemptRun, setClaudeBin } = require('./attemptSupervisor');
const { resolveBinary, checkClaude } = require('./providerHealth');
const workspace = require('./workspaceManager');
const { removeArtifacts } = require('./artifactStore');
const { removeRepo } = require('./git/repoManager');
const { deliverChanges } = require('./changeDelivery');
const { DELIVERY_STATUS } = require('../constants/delivery');
const { getRunner } = require('./runners/runnerFactory');
const getLogger = require('../utils/logger');
const { CHANNELS } = require('../constants/eventTypes');
const { JOB_STATUS, isTerminal } = require('../constants/jobStatus');

const logger = getLogger(__filename);

const POLL_MS = config.get('worker.pollMs');
const HEARTBEAT_MS = config.get('worker.heartbeatSec') * 1000;
const TAIL_MS = config.get('worker.tailIntervalMs');
const WEBHOOK_MS = config.get('worker.webhookIntervalSec') * 1000;
const HEALTH_MS = config.get('worker.healthIntervalSec') * 1000;
const REAPER_ENABLED = config.get('scheduler.reaperEnabled');
const REAPER_MS = config.get('scheduler.reaperIntervalSec') * 1000;
const RETENTION_ENABLED = config.get('scheduler.retentionEnabled');
const CONCURRENCY = config.get('worker.concurrency');
const REAPER_LOCK_KEY = 728371;

/** Run fn on an interval; never throws, never overlaps itself. */
const every = (ms, name, fn) => {
    let busy = false;
    const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            await fn();
        } catch (error) {
            logger.error(`${name} failed: ${error.message}`, error);
        } finally {
            busy = false;
        }
    }, ms);
    timer.unref();
    return timer;
};

class Worker {
    constructor({ hostId = HOST.hostId, runner = getRunner() } = {}) {
        this.hostId = hostId;
        this.runner = runner;
        this.runs = new Map();
        this.timers = [];
        this.stopping = false;
        this.claiming = false;
        this.reaperLock = new AdvisoryLock(REAPER_LOCK_KEY);
    }

    /** Boot: binaries, skills, listeners, recovery, loops. */
    start = async () => {
        if (this.runner.name !== 'docker') {
            const bin = await resolveBinary(config.get('llm.claudeBin'));
            if (!bin) throw new Error(`Claude Code binary '${config.get('llm.claudeBin')}' not found on PATH.`);
            this.claudeBin = bin;
            setClaudeBin(bin);
        }
        await skillService.syncFromDisk().catch((error) => logger.error(`Skill sync failed: ${error.message}`));
        await notifyHub.start([CHANNELS.JOB_QUEUED, CHANNELS.JOB_CANCEL]);
        notifyHub.on(CHANNELS.JOB_QUEUED, () => this.claimLoop());
        notifyHub.on(CHANNELS.JOB_CANCEL, ({ jobId }) => this.cancelLocal(jobId));
        await this.recover();
        this.timers.push(
            every(TAIL_MS, 'supervise', this.supervise),
            every(POLL_MS, 'claim', this.claimLoop),
            every(HEARTBEAT_MS, 'heartbeat', this.heartbeat),
            every(WEBHOOK_MS, 'webhooks', webhookService.dispatchDueWebhooks),
            every(HEALTH_MS, 'health', this.health),
        );
        if (REAPER_ENABLED) this.timers.push(every(REAPER_MS, 'reaper', this.reaper));
        await this.health();
        logger.info(
            `Worker started ${JSON.stringify({ hostId: this.hostId, runner: this.runner.name, concurrency: CONCURRENCY })}`,
        );
    };

    supervise = async () => {
        for (const [attemptId, run] of this.runs) {
            try {
                if (await run.tick()) this.runs.delete(attemptId);
            } catch (error) {
                logger.error(`Supervising attempt ${attemptId} failed (will retry): ${error.message}`, error);
            }
        }
        if (this.runs.size < CONCURRENCY) this.claimLoop();
    };

    claimLoop = async () => {
        if (this.stopping || this.claiming) return;
        this.claiming = true;
        try {
            while (!this.stopping && this.runs.size < CONCURRENCY) {
                const claimed = await executionService.claimNextJob({ hostId: this.hostId, runtime: this.runner.name });
                if (!claimed) break;
                const run = await AttemptRun.launch(claimed, this.runner);
                if (run) this.runs.set(claimed.attempt.id, run);
            }
        } catch (error) {
            logger.error(`Claim loop failed: ${error.message}`, error);
        } finally {
            this.claiming = false;
        }
    };

    heartbeat = async () => {
        const runs = [...this.runs.values()];
        await executionService.renewLeases(
            this.hostId,
            runs.map((r) => r.job.id),
        );
        const active = await executionService.activeJobsForHost(this.hostId);
        active
            .filter((j) => j.cancelRequested || j.status === JOB_STATUS.CANCELLING)
            .forEach((j) => this.cancelLocal(j.id));
    };

    cancelLocal = (jobId) => {
        [...this.runs.values()].filter((r) => r.job.id === jobId).forEach((r) => r.requestStop('cancel'));
    };

    recoverOne = async ({ job, attempt }) => {
        if (isTerminal(job.status) || !attempt.runtimeHandle) {
            await executionService.abandonBeforeStart(attempt, 'Worker restarted before Claude started.');
            return;
        }
        const app = await executionService.getAppInternal(job.appId);
        this.runs.set(attempt.id, await AttemptRun.reattach({ job, attempt, app }));
    };

    /** Re-attach to attempts this host was running before a restart (decision D2). */
    recover = async () => {
        const open = await executionService.openAttemptsForHost(this.hostId);
        for (const pair of open) {
            await this.recoverOne(pair).catch((error) =>
                logger.error(`Recovery of attempt ${pair.attempt.id} failed: ${error.message}`, error),
            );
        }
        if (open.length) logger.info(`Recovered ${open.length} attempt(s)`);
    };

    finalizeForeign = async ({ job, attempt }) => {
        const dirs = workspace.attemptDirs({
            jobId: job.id,
            appId: job.appId,
            attemptN: attempt.n,
            wsDir: attempt.workspacePath,
        });
        const outcome = classifyOutcome({
            result: null,
            exit: workspace.readExit(dirs),
            requiresStructuredOutput: false,
        });
        await executionService.finalizeAttempt({ attempt }, outcome, {
            ...executionService.EMPTY_RUN,
            exit: workspace.readExit(dirs),
            startedActing: attempt.startedActing,
            actedOutsideWorkspace: attempt.actedOutsideWorkspace,
            tokenCount: Number(attempt.tokenCount || 0),
        });
    };

    /** Finish deliveries interrupted by a worker crash (the job already succeeded). */
    redeliverStranded = async () => {
        const stranded = await deliveryService.strandedDeliveries(new Date(Date.now() - 5 * 60 * 1000));
        for (const job of stranded) {
            await this.isolated(`redelivery of job ${job.id}`, () => this.redeliverOne(job));
        }
    };

    redeliverOne = async (job) => {
        const attempt = await executionService.latestAttemptInternal(job.id);
        const app = await executionService.getAppInternal(job.appId);
        const wsDir = attempt && attempt.workspacePath;
        const delivery =
            wsDir && fs.existsSync(wsDir) && app
                ? await deliverChanges({ job, attempt, manifest: attempt.manifest, app, wsDir })
                : {
                      status: DELIVERY_STATUS.FAILED,
                      error: 'Workspace no longer available for delivery.',
                      artifacts: [],
                  };
        await deliveryService.recordDelivery(job, delivery);
        this.removeJobFiles([job.id]);
    };

    /** Run one housekeeping item; a failure is logged and never stops the rest of the tick. */
    isolated = async (label, fn) => {
        try {
            await fn();
        } catch (error) {
            logger.error(`Reaper: ${label} failed: ${error.message}`, error);
        }
    };

    removeJobFiles = (jobIds) =>
        jobIds.forEach((id) => {
            workspace.removeJobDirs(id);
            removeRepo(id);
        });

    /** Single-instance housekeeping: release limit waits, recover jobs of dead hosts, retention. */
    reaper = async () => {
        if (!(await this.reaperLock.tryAcquire())) return;
        await this.isolated('release of limit waits', async () => {
            if (await executionService.releaseWaitingLimitJobs()) await notifyHub.publish(CHANNELS.JOB_QUEUED, {});
        });
        const foreign = await executionService.expiredForeignAttempts(this.hostId);
        for (const pair of foreign)
            await this.isolated(`recovery of job ${pair.job.id}`, () => this.finalizeForeign(pair));
        await this.isolated('stranded deliveries', this.redeliverStranded);
        if (!RETENTION_ENABLED) return;
        await this.isolated('retention', async () => {
            const { jobIds, failedWorkspaceJobIds, sessions } = await applyRetention();
            this.removeJobFiles([...jobIds, ...failedWorkspaceJobIds]);
            jobIds.forEach(removeArtifacts);
            sessions.forEach((s) => s.workspacePath && fs.rmSync(s.workspacePath, { recursive: true, force: true }));
        });
    };

    health = async () => {
        const claude = await checkClaude({ runnerName: this.runner.name, claudeBin: this.claudeBin });
        await providerStateService.recordHealth({
            ...claude,
            runner: this.runner.name,
            hostId: this.hostId,
            checkedAt: new Date().toISOString(),
        });
        if (!claude.ok) logger.warn(`Claude Code health check failed: ${claude.error}`);
    };

    /** Stop claiming and detach: running attempts keep going and are re-attached on the next start. */
    stop = async () => {
        this.stopping = true;
        this.timers.forEach(clearInterval);
        const deadline = Date.now() + config.get('server.shutdownGraceSec') * 1000;
        while ((this.claiming || [...this.runs.values()].some((r) => r.finalizing)) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await notifyHub.stop();
        await this.reaperLock.release();
        await shutdownTracing();
        logger.info(`Worker stopped; ${this.runs.size} attempt(s) left running for re-attach`);
    };
}

module.exports = { Worker };
