'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const executionService = require('../services/execution.service');
const providerStateService = require('../services/providerState.service');
const sessionService = require('../services/session.service');
const deliveryService = require('../services/delivery.service');
const { isFeatureEnabled } = require('../services/app.service');
const { classifyOutcome } = require('../services/outcome.service');
const { buildAttemptTrace } = require('../services/trace.service');
const { recordAttemptTrace, isTracingEnabled } = require('../infra/langfuse');
const { weightedTokens } = require('../services/usage.service');
const { getSecrets } = require('../infra/secrets');
const workspace = require('./workspaceManager');
const { buildArgs, buildEnv, buildSettings } = require('./argsBuilder');
const {
    parseLine,
    toEventRows,
    toolUses,
    toolResults,
    toolEffect,
    messageUsage,
    TOOL_EFFECT,
} = require('./streamParser');
const { readNewLines } = require('./streamTail');
const { runnerFor, isSandboxOn } = require('./runners/runnerFactory');
const { repoPaths, cloneRepo, removeRepo, listTrackedFiles } = require('./git/repoManager');
const { collectOutputs } = require('./artifactStore');
const { deliverChanges } = require('./changeDelivery');
const getLogger = require('../utils/logger');
const { runWithContext } = require('../utils/requestContext');
const { ATTEMPT_MODE, CREDENTIAL_PROFILE, CHANGE_MODE } = require('../constants/skill');
const { ERROR_CLASS } = require('../constants/errorClasses');
const { JOB_STATUS, isTerminal } = require('../constants/jobStatus');
const { FEATURES } = require('../constants/features');
const { DELIVERY_STATUS } = require('../constants/delivery');

const logger = getLogger(__filename);

const MAX_LINE = config.get('job.maxStreamLineBytes');
const MAX_OUTPUT = config.get('job.maxOutputBytes');
const KILL_GRACE_SEC = config.get('runner.killGraceSec');
const REATTACH_GRACE_MS = config.get('worker.reattachGraceSec') * 1000;
const CACHE_READ_WEIGHT = config.get('usage.cacheReadWeight');
const SOFT_CAP_RATIO = config.get('usage.softCapRatio');
let claudeBin = config.get('llm.claudeBin');
const SANDBOX_PATH_ENV = '/usr/local/bin:/usr/bin:/bin';

/**
 * Use an absolute `claude` path for local/host runners (resolved once at worker boot).
 * @param {string} absolutePath
 * @returns {void}
 */
const setClaudeBin = (absolutePath) => {
    claudeBin = absolutePath;
};

/** Error raised before Claude starts; carries the class used by the retry policy. */
class LaunchError extends Error {
    constructor(message, errorClass = ERROR_CLASS.GATEWAY) {
        super(message);
        this.errorClass = errorClass;
    }
}

const credentialFor = (manifest) => {
    const secrets = getSecrets();
    if (manifest.credentialProfile === CREDENTIAL_PROFILE.API_KEY) {
        if (!secrets.anthropicApiKey)
            throw new LaunchError('No Anthropic API key configured.', ERROR_CLASS.PROVIDER_AUTH);
        return { anthropicApiKey: secrets.anthropicApiKey };
    }
    if (!secrets.claudeOauthToken)
        throw new LaunchError('No Claude OAuth token configured (claude setup-token).', ERROR_CLASS.PROVIDER_AUTH);
    return { claudeOauthToken: secrets.claudeOauthToken };
};

const skillEnvFor = (manifest) => {
    const values = getSecrets().values;
    return Object.fromEntries(
        Object.entries(manifest.env || {}).map(([name, ref]) => {
            const key = ref.replace(/^secret:/, '');
            if (!(key in values))
                throw new LaunchError(
                    `Secret '${key}' required by the skill is not configured.`,
                    ERROR_CLASS.VALIDATION,
                );
            return [name, values[key]];
        }),
    );
};

const skillDirs = (manifest) =>
    Object.fromEntries(
        [manifest.name, ...(manifest.uses || [])].map((name) => [name, path.join(PATHS.skillsDir, name)]),
    );

const resolveSessionPlan = async (job, attempt) => {
    if (attempt.mode === ATTEMPT_MODE.RESUME && job.resumeAttemptId) {
        const previous = await executionService.getAttemptInternal(job.resumeAttemptId);
        if (previous && previous.claudeSessionId && previous.workspacePath && fs.existsSync(previous.workspacePath)) {
            return {
                wsDir: previous.workspacePath,
                resumeSessionId: previous.claudeSessionId,
                mode: ATTEMPT_MODE.RESUME,
            };
        }
    }
    if (job.sessionId) {
        const session = await sessionService.getSessionInternal(job.sessionId);
        if (session)
            return {
                wsDir: session.workspacePath,
                resumeSessionId: session.claudeSessionId || null,
                mode: ATTEMPT_MODE.FRESH,
            };
    }
    return { wsDir: null, resumeSessionId: null, mode: ATTEMPT_MODE.FRESH };
};

const prepareRepo = async (job, wsDir, app) => {
    if (!job.repoUrl) return;
    const repo = repoPaths(job.id, wsDir);
    const credential = app.gitCredentialRef ? getSecrets().git[app.gitCredentialRef] || null : null;
    try {
        await cloneRepo({ repoUrl: job.repoUrl, repoRef: job.repoRef, ...repo, credential });
        fs.writeFileSync(path.join(wsDir, 'repo-files.txt'), await listTrackedFiles(repo));
    } catch (error) {
        throw new LaunchError(`Repository clone failed: ${error.message}`);
    }
};

const pathEnvFor = (runner) =>
    runner.name === 'docker'
        ? SANDBOX_PATH_ENV
        : `${path.dirname(claudeBin)}:${path.dirname(process.execPath)}:${SANDBOX_PATH_ENV}`;

const buildCommand = ({ job, manifest, runner, paths, plan }) => ({
    env: buildEnv({
        paths,
        credential: credentialFor(manifest),
        skillEnv: skillEnvFor(manifest),
        pathEnv: pathEnvFor(runner),
        egressProxy: config.get('runner.egressProxy'),
    }),
    args: buildArgs({
        jobId: job.id,
        manifest,
        model: job.model,
        paths,
        mode: plan.mode,
        resumeSessionId: plan.resumeSessionId,
        newSessionId: crypto.randomUUID(),
    }),
    wrapArgs: [
        '--run',
        paths.run,
        '--control',
        paths.control,
        '--timeout',
        String(job.timeoutSec),
        '--grace',
        String(KILL_GRACE_SEC),
        '--max-output',
        String(MAX_OUTPUT),
    ],
});

/**
 * Prepare directories and files for an attempt and build its command (no process is started).
 * @param {{job: Object, attempt: Object, app: Object, runner: Object, plan: Object}} ctx
 * @returns {Object} launch spec for runner.start
 */
const buildLaunchSpec = ({ job, attempt, app, runner, plan }) => {
    const { manifest } = attempt;
    const dirs = workspace.attemptDirs({ jobId: job.id, appId: job.appId, attemptN: attempt.n, wsDir: plan.wsDir });
    const skills = skillDirs(manifest);
    dirs.mcpConfigFile = Object.keys(manifest.mcpServers || {}).length ? path.join(dirs.metaDir, 'mcp.json') : null;
    const paths = runner.sandboxPaths(dirs, skills);
    workspace.prepareAttempt(dirs, {
        input: job.input,
        settings: buildSettings({ paths, sandboxOn: isSandboxOn(runner) }),
        mcpConfig: manifest.mcpServers,
    });
    return {
        dirs,
        skills,
        ...buildCommand({ job, manifest, runner, paths, plan }),
        name: `gw-${attempt.id}`,
        claudeBin,
        runtimeMaxSec: job.timeoutSec + KILL_GRACE_SEC * 4 + 60,
        labels: { 'gw.job': job.id, 'gw.attempt': attempt.id, 'gw.app': app.id },
    };
};

/** Prepare, clone and start the process. Throws LaunchError-like errors; secrets are always removed. */
const startProcess = async ({ job, attempt, app, runner }) => {
    let spec = null;
    try {
        spec = buildLaunchSpec({ job, attempt, app, runner, plan: await resolveSessionPlan(job, attempt) });
        await prepareRepo(job, spec.dirs.wsDir, app);
        const envFile = runner.usesEnvFile ? workspace.writeEnvFile(spec.dirs, spec.env) : null;
        const handle = await runner.start({ ...spec, envFile });
        return { spec, handle };
    } finally {
        if (spec) workspace.removeSecrets(spec.dirs);
    }
};

/** Supervises one running attempt. Survives worker restarts via AttemptRun.reattach(). */
class AttemptRun {
    constructor({ job, attempt, app, runner, dirs, handle, state }) {
        Object.assign(this, { job, attempt, app, runner, dirs, handle });
        this.manifest = attempt.manifest;
        this.state = {
            offset: Number(attempt.streamOffset || 0),
            seq: Number(attempt.streamSeq || 0),
            startedActing: Boolean(attempt.startedActing),
            actedOutsideWorkspace: Boolean(attempt.actedOutsideWorkspace),
            claudeSessionId: attempt.claudeSessionId || null,
            usageByMessage: new Map(),
            pendingEffects: new Map(),
            tokenCount: Number(attempt.tokenCount || 0),
            resultEvent: null,
            lastRateLimit: null,
            deadSince: null,
            softWarned: false,
            stopRequested: null,
            budgetUsedAtStart: 0,
            ...state,
        };
        this.finished = false;
        this.finalizing = false;
    }

    /**
     * Start a freshly claimed attempt. Returns null when it ended before Claude started.
     * @param {{job: Object, attempt: Object, app: Object}} claimed
     * @param {Object} runner
     * @returns {Promise<AttemptRun|null>}
     */
    static launch = async ({ job, attempt, app }, runner) =>
        runWithContext({ jobId: job.id, attemptId: attempt.id, appId: job.appId }, async () => {
            if (!(await executionService.markProvisioning(job))) {
                await executionService.abandonBeforeStart(attempt, 'Cancelled before start.', ERROR_CLASS.CANCELLED);
                return null;
            }
            let started;
            try {
                started = await startProcess({ job, attempt, app, runner });
            } catch (error) {
                logger.warn(`Launch failed: ${error.message}`);
                await executionService.abandonBeforeStart(
                    attempt,
                    error.message,
                    error.errorClass || ERROR_CLASS.GATEWAY,
                );
                return null;
            }
            const { spec, handle } = started;
            const run = new AttemptRun({
                job,
                attempt,
                app,
                runner,
                dirs: spec.dirs,
                handle,
                state: { claudeSessionId: null },
            });
            try {
                await run.recordBudgetBaseline();
                const running = await executionService.markRunning(job, attempt, {
                    handle,
                    workspacePath: spec.dirs.wsDir,
                });
                if (!running) run.requestStop('cancel');
            } catch (error) {
                // the process is already running: keep supervising it (finalize works from provisioning too)
                logger.error(`Recording the started attempt failed; supervising anyway: ${error.message}`, error);
            }
            return run;
        });

    /**
     * Re-attach to an attempt started by a previous worker process.
     * @param {{job: Object, attempt: Object, app: Object}} ctx
     * @returns {Promise<AttemptRun>}
     */
    static reattach = async ({ job, attempt, app }) => {
        const runner = runnerFor(attempt.runtimeHandle && attempt.runtimeHandle.kind);
        const dirs = workspace.attemptDirs({
            jobId: job.id,
            appId: job.appId,
            attemptN: attempt.n,
            wsDir: attempt.workspacePath,
        });
        const run = new AttemptRun({ job, attempt, app, runner, dirs, handle: attempt.runtimeHandle });
        run.reattached = true;
        await run.recordBudgetBaseline();
        logger.info(`Re-attached ${JSON.stringify({ jobId: job.id, attempt: attempt.n, offset: run.state.offset })}`);
        return run;
    };

    recordBudgetBaseline = async () => {
        if (!this.app.dailyTokenBudget) return;
        this.state.budgetUsedAtStart = await executionService.budgetUsedToday(this.app);
    };

    requestStop = (reason) => {
        if (this.state.stopRequested) return;
        this.state.stopRequested = reason;
        workspace.requestStop(this.dirs, reason);
    };

    applyEvent = (event, rows) => {
        if (event.type === 'system' && event.subtype === 'init' && event.session_id)
            this.state.claudeSessionId = event.session_id;
        if (event.type === 'result') this.state.resultEvent = event;
        if (event.type === 'rate_limit_event') this.state.lastRateLimit = event.rate_limit_info || null;
        this.trackToolEffects(event);
        const usage = messageUsage(event);
        if (usage) this.state.usageByMessage.set(usage.messageId, weightedTokens(usage.usage, CACHE_READ_WEIGHT));
        rows.push(
            ...toEventRows(event, { logContent: Boolean(this.manifest.logContent) }).map((row) => ({
                ...row,
                seq: (this.state.seq += 1),
            })),
        );
    };

    applyEffect = (effect) => {
        if (effect !== TOOL_EFFECT.NONE) this.state.startedActing = true;
        if (effect === TOOL_EFFECT.OUTSIDE) this.state.actedOutsideWorkspace = true;
    };

    /**
     * A tool call counts as acting only once its result shows it ran: denied calls had no effect.
     * Results whose call we never saw (re-attached mid-call) count as outside effects, to stay conservative.
     */
    trackToolEffects = (event) => {
        toolUses(event).forEach(({ id, name }) => {
            const effect = toolEffect(name);
            if (effect !== TOOL_EFFECT.NONE) this.state.pendingEffects.set(id, effect);
        });
        toolResults(event).forEach(({ id, denied }) => {
            const known = this.state.pendingEffects.has(id);
            const effect = known ? this.state.pendingEffects.get(id) : TOOL_EFFECT.OUTSIDE;
            this.state.pendingEffects.delete(id);
            if (!denied && (known || this.reattached)) this.applyEffect(effect);
        });
    };

    /** Calls still without a result when the run ended may have run: count them. */
    settlePendingEffects = () => {
        this.state.pendingEffects.forEach((effect) => this.applyEffect(effect));
        this.state.pendingEffects.clear();
    };

    liveTokens = () => {
        const fromMessages = [...this.state.usageByMessage.values()].reduce((a, b) => a + b, 0);
        const fromResult = this.state.resultEvent ? weightedTokens(this.state.resultEvent.usage, CACHE_READ_WEIGHT) : 0;
        return Math.max(fromMessages, fromResult, this.state.tokenCount);
    };

    consumeStream = async () => {
        const { lines, offset } = readNewLines(workspace.streamFile(this.dirs), this.state.offset, MAX_LINE);
        if (offset === this.state.offset) return;
        const rows = [];
        lines
            .map(parseLine)
            .filter(Boolean)
            .forEach((event) => this.applyEvent(event, rows));
        this.state.tokenCount = this.liveTokens();
        const { offset: previous } = this.state;
        await executionService.recordProgress(this.attempt, {
            events: rows,
            streamOffset: offset,
            streamSeq: this.state.seq,
            fields: {
                startedActing: this.state.startedActing,
                actedOutsideWorkspace: this.state.actedOutsideWorkspace,
                tokenCount: this.state.tokenCount,
                claudeSessionId: this.state.claudeSessionId,
            },
        });
        this.state.offset = offset;
        if (this.state.lastRateLimit && previous !== offset) await this.recordRateLimit();
    };

    recordRateLimit = async () => {
        const info = this.state.lastRateLimit;
        this.state.lastRateLimit = null;
        await providerStateService
            .recordRateLimit(info)
            .catch((error) => logger.warn(`Rate limit record failed: ${error.message}`));
    };

    checkBudget = () => {
        const budget = Number(this.app.dailyTokenBudget || 0);
        if (!budget || this.state.stopRequested) return;
        const total = this.state.budgetUsedAtStart + this.state.tokenCount;
        if (total >= budget) {
            logger.warn(`Hard budget cap reached for app ${this.app.id}; stopping job ${this.job.id}`);
            this.requestStop('budget');
        } else if (!this.state.softWarned && total >= budget * SOFT_CAP_RATIO) {
            this.state.softWarned = true;
            logger.warn(`Soft budget cap reached for app ${this.app.id} (${total}/${budget} tokens)`);
        }
    };

    isGone = async () => {
        if (workspace.hasExit(this.dirs)) return true;
        if (await this.runner.isAlive(this.handle, this.dirs)) {
            this.state.deadSince = null;
            return false;
        }
        this.state.deadSince = this.state.deadSince || Date.now();
        return Date.now() - this.state.deadSince > REATTACH_GRACE_MS;
    };

    /**
     * One supervision step. Returns true when the attempt is finished and can be dropped.
     * @returns {Promise<boolean>}
     */
    tick = async () =>
        runWithContext({ jobId: this.job.id, attemptId: this.attempt.id, appId: this.job.appId }, async () => {
            if (this.finished || this.finalizing) return this.finished;
            await this.consumeStream();
            this.checkBudget();
            if (await this.isGone()) await this.finalize();
            return this.finished;
        });

    collectRunRecord = () => {
        const exit = workspace.readExit(this.dirs);
        const result = this.state.resultEvent;
        const requiresStructuredOutput = Boolean(this.manifest.outputSchema);
        const outcome = classifyOutcome({ result, exit, requiresStructuredOutput });
        const output = result
            ? result.structured_output !== undefined
                ? result.structured_output
                : { text: result.result }
            : null;
        const { artifacts } = fs.existsSync(this.dirs.wsDir)
            ? collectOutputs(this.job.id, this.dirs.wsDir)
            : { artifacts: [] };
        return {
            outcome,
            run: {
                exit,
                result,
                output: outcome.succeeded ? output : null,
                artifacts,
                startedActing: this.state.startedActing,
                actedOutsideWorkspace: this.state.actedOutsideWorkspace,
                canResume: Boolean(this.state.claudeSessionId) && fs.existsSync(this.dirs.wsDir),
                claudeSessionId: this.state.claudeSessionId,
                tokenCount: this.liveTokens(),
            },
        };
    };

    /** Read the whole attempt stream (bounded by job.maxOutputBytes) for the trace. */
    readAllEvents = () => {
        const file = workspace.streamFile(this.dirs);
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').split('\n').map(parseLine).filter(Boolean);
    };

    /** Send the attempt to LangFuse when enabled. After the DB write; never affects the job. */
    trace = (job, record, status) => {
        if (!isTracingEnabled()) return;
        try {
            recordAttemptTrace(
                buildAttemptTrace({
                    job,
                    attempt: this.attempt,
                    events: this.readAllEvents(),
                    outcome: record.outcome,
                    run: record.run,
                    status,
                }),
            );
        } catch (error) {
            logger.warn(`Tracing skipped for job ${job.id}: ${error.message}`);
        }
    };

    /** @returns {Promise<string|null>} the delivery status, or null when no delivery applies */
    deliver = async (finalJob) => {
        if (this.manifest.changes === CHANGE_MODE.NONE || !isFeatureEnabled(this.app, FEATURES.CHANGE_DELIVERY))
            return null;
        const delivery = await deliverChanges({
            job: finalJob,
            attempt: this.attempt,
            manifest: this.manifest,
            app: this.app,
            wsDir: this.dirs.wsDir,
        });
        await deliveryService.recordDelivery(finalJob, delivery);
        return delivery.status;
    };

    /** Destroy the sandbox; delete files only after a success that needs nothing more (failed deliveries keep them for redelivery). */
    cleanup = async (status, deliveryStatus) => {
        await this.runner.destroy(this.handle).catch(() => {});
        if (status !== JOB_STATUS.SUCCEEDED || this.job.sessionId || deliveryStatus === DELIVERY_STATUS.FAILED) return;
        removeRepo(this.job.id);
        workspace.removeJobDirs(this.job.id);
    };

    /**
     * Classify, persist (result.json first, so a DB outage loses nothing), move the job on, deliver, clean up.
     * @returns {Promise<void>}
     */
    finalize = async () => {
        this.finalizing = true;
        try {
            await this.consumeStream();
            this.settlePendingEffects();
            const record = workspace.readResultRecord(this.dirs) || this.collectRunRecord();
            workspace.writeResultRecord(this.dirs, record);
            const { status, job } = await executionService.finalizeAttempt(
                { attempt: this.attempt },
                record.outcome,
                record.run,
            );
            this.trace(job || this.job, record, status);
            const deliveryStatus = status === JOB_STATUS.SUCCEEDED && job ? await this.deliver(job) : null;
            if (!job || isTerminal(status) || status === JOB_STATUS.QUEUED || status === JOB_STATUS.WAITING_LIMIT) {
                await this.cleanup(status, deliveryStatus);
            }
            this.finished = true;
        } finally {
            this.finalizing = false;
        }
    };
}

module.exports = { AttemptRun, LaunchError, buildLaunchSpec, setClaudeBin };
