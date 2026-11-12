'use strict';

const config = require('../../config');

const skillSourceRepository = require('../repositories/skillSource.repository');
const skillSyncRepository = require('../repositories/skillSync.repository');
const appSecretService = require('./appSecret.service');
const { recordAudit } = require('./audit.service');
const { checkRepoUrl } = require('./jobRequest.service');
const notifyHub = require('../infra/notifyHub');
const { withTransaction } = require('../utils/transaction');
const getLogger = require('../utils/logger');
const { NotFoundError, ValidationError, PG_ERROR } = require('../utils/AppError');
const { SKILL_SYNC_STATUS, GIT_REF_PATTERN } = require('../constants/skill');
const { CHANNELS } = require('../constants/eventTypes');
const { API_ERROR } = require('../constants/apiErrors');
const { AUDIT_ACTION } = require('../constants/audit');

const logger = getLogger(__filename);

const WAIT_MAX_SEC = config.get('skills.syncWaitMaxSec');
// a running sync whose worker stopped renewing it (worker heartbeat) is taken over after this long
const STALE_SYNC_MS = config.get('worker.leaseSec') * 1000;
const REF = GIT_REF_PATTERN;
const SUB_PATH = /^[A-Za-z0-9._/-]{0,300}$/;
const DONE = Object.freeze([SKILL_SYNC_STATUS.SUCCEEDED, SKILL_SYNC_STATUS.FAILED]);

const sourceNotFound = () => new NotFoundError('Skill source not found.', API_ERROR.SKILL_SOURCE_NOT_FOUND);

const toPublicSource = (s) => ({
    sourceId: s.id,
    repoUrl: s.repoUrl,
    ref: s.ref,
    path: s.path,
    credentialSecret: s.credentialSecret,
    lastSyncedAt: s.lastSyncedAt,
    lastCommit: s.lastCommit,
    lastError: s.lastError,
    createdAt: s.createdAt,
});

const toPublicSync = (s) => ({
    syncId: s.id,
    sourceId: s.sourceId,
    status: s.status,
    added: (s.result && s.result.added) || [],
    unchanged: (s.result && s.result.unchanged) || [],
    failed: (s.result && s.result.failed) || [],
    error: s.error ? { code: API_ERROR.SKILL_SOURCE_FAILED, message: s.error } : null,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
});

const checkSubPath = (subPath) => {
    if (!SUB_PATH.test(subPath) || subPath.startsWith('/') || subPath.split('/').includes('..')) {
        throw new ValidationError('Path (path) must be a relative folder inside the repository.');
    }
};

/**
 * Register a git repository the app's skills are synced from (spec §7).
 * @param {{appId: string}} context
 * @param {{repoUrl: string, ref?: string, path?: string, credentialSecret?: string}} body
 * @returns {Promise<Object>}
 * @throws {ValidationError}
 */
const createSource = async ({ appId }, { repoUrl, ref = null, path: subPath = '', credentialSecret = null }) => {
    checkRepoUrl(repoUrl);
    if (ref !== null && !REF.test(ref)) throw new ValidationError('Ref (ref) is not a valid branch or tag name.');
    checkSubPath(subPath);
    const source = await skillSourceRepository.create({ appId, repoUrl, ref, path: subPath, credentialSecret });
    await recordAudit({
        appId,
        action: AUDIT_ACTION.SKILL_SOURCE_CREATED,
        targetType: 'skill_source',
        targetId: source.id,
        details: { repoUrl },
    });
    return toPublicSource(source);
};

/**
 * @param {{appId: string}} context
 * @returns {Promise<Object[]>}
 */
const listSources = async ({ appId }) => (await skillSourceRepository.listByApp(appId)).map(toPublicSource);

/**
 * Remove a source. Skills already synced from it stay; they are just no longer tied to it.
 * @param {{appId: string}} context
 * @param {string} sourceId
 * @returns {Promise<void>}
 * @throws {NotFoundError} SKILL_SOURCE_NOT_FOUND
 */
const deleteSource = async ({ appId }, sourceId) => {
    if (!(await skillSourceRepository.destroy(sourceId, appId))) throw sourceNotFound();
    await recordAudit({
        appId,
        action: AUDIT_ACTION.SKILL_SOURCE_DELETED,
        targetType: 'skill_source',
        targetId: sourceId,
    });
};

const loadSync = async (appId, sourceId, syncId) => {
    const sync = await skillSyncRepository.findByIdForApp(syncId, appId, sourceId);
    if (!sync) throw new NotFoundError('Skill sync not found.', API_ERROR.SKILL_SYNC_NOT_FOUND);
    return sync;
};

/**
 * Resolve when the sync finishes or the timeout passes.
 * @param {string} appId
 * @param {string} sourceId
 * @param {string} syncId
 * @param {number} timeoutMs
 * @returns {Promise<Object>} the last observed sync row
 */
const waitForSync = async (appId, sourceId, syncId, timeoutMs) => {
    await notifyHub.start([CHANNELS.SKILL_SYNC_DONE]);
    return new Promise((resolve) => {
        let timer = null;
        let settled = false;
        let last = null;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            notifyHub.removeListener(CHANNELS.SKILL_SYNC_DONE, onDone);
            resolve(last);
        };
        const check = async () => {
            last = await skillSyncRepository.findByIdForApp(syncId, appId, sourceId);
            if (!last || DONE.includes(last.status)) done();
        };
        const onDone = (payload) => {
            if (payload.syncId === syncId) check().catch(() => {});
        };
        notifyHub.on(CHANNELS.SKILL_SYNC_DONE, onDone);
        timer = setTimeout(done, timeoutMs);
        check().catch(done);
    });
};

/**
 * Queue a sync, or join the one a concurrent request just queued (unique index on the active sync).
 * @param {string} appId
 * @param {string} sourceId
 * @returns {Promise<{sync: Object, joined: boolean}>}
 */
const createSyncOnce = async (appId, sourceId) => {
    try {
        return { sync: await skillSyncRepository.create({ appId, sourceId }), joined: false };
    } catch (error) {
        const pgCode = (error.parent || error.original || {}).code;
        const active = pgCode === PG_ERROR.UNIQUE ? await skillSyncRepository.findActive(appId, sourceId) : null;
        if (!active) throw error;
        return { sync: active, joined: true };
    }
};

/**
 * "Sync now": queue a sync of the source (or join the one already queued or running) for the worker.
 * With waitSec it waits for the result, up to skills.syncWaitMaxSec.
 * @param {{appId: string}} context
 * @param {string} sourceId
 * @param {{waitSec?: number}} [options]
 * @returns {Promise<{sync: Object, finished: boolean}>}
 * @throws {NotFoundError} SKILL_SOURCE_NOT_FOUND
 */
const requestSync = async ({ appId }, sourceId, { waitSec = 0 } = {}) => {
    if (!(await skillSourceRepository.findByIdForApp(sourceId, appId))) throw sourceNotFound();
    let sync = await skillSyncRepository.findActive(appId, sourceId);
    if (!sync) {
        const created = await createSyncOnce(appId, sourceId);
        sync = created.sync;
        if (!created.joined) {
            await recordAudit({
                appId,
                action: AUDIT_ACTION.SKILL_SYNC_REQUESTED,
                targetType: 'skill_source',
                targetId: sourceId,
            });
            await notifyHub.publish(CHANNELS.SKILL_SYNC_QUEUED, { syncId: sync.id });
        }
    }
    if (waitSec > 0) {
        sync = (await waitForSync(appId, sourceId, sync.id, Math.min(waitSec, WAIT_MAX_SEC) * 1000)) || sync;
    }
    return { sync: toPublicSync(sync), finished: DONE.includes(sync.status) };
};

/**
 * @param {{appId: string}} context
 * @param {string} sourceId
 * @param {string} syncId
 * @returns {Promise<Object>}
 * @throws {NotFoundError} SKILL_SYNC_NOT_FOUND
 */
const getSync = async ({ appId }, sourceId, syncId) => toPublicSync(await loadSync(appId, sourceId, syncId));

// ---------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------

/**
 * Worker: claim the next queued (or abandoned) sync with its source.
 * @param {string} owner host id
 * @returns {Promise<{sync: Object, source: Object}|null>}
 */
const claimNextSyncInternal = async (owner) => {
    const sync = await withTransaction('skillSync.claim', (transaction) =>
        skillSyncRepository.lockNextInternal(
            { owner, staleBefore: new Date(Date.now() - STALE_SYNC_MS) },
            { transaction },
        ),
    );
    if (!sync) return null;
    const source = await skillSourceRepository.findByIdInternal(sync.sourceId);
    if (!source) {
        await skillSyncRepository.finishInternal(sync, {
            status: SKILL_SYNC_STATUS.FAILED,
            error: 'The source was deleted.',
        });
        return null;
    }
    return { sync, source };
};

/**
 * Worker: the git credential for a source, from the app secret it names. A value of the form
 * "username:token" sets the username; otherwise the value is the token.
 * @param {Object} source
 * @returns {Promise<{username?: string, token: string}|null>}
 * @throws {Error} when the named secret does not exist
 */
const credentialInternal = async (source) => {
    if (!source.credentialSecret) return null;
    const values = await appSecretService.valuesForAppInternal(source.appId);
    const value = values[source.credentialSecret];
    if (!value) throw new Error(`Secret '${source.credentialSecret}' is not set for this app.`);
    const split = value.indexOf(':');
    return split > 0 ? { username: value.slice(0, split), token: value.slice(split + 1) } : { token: value };
};

/**
 * Worker: record a sync's outcome on the sync and its source, and wake waiting callers.
 * @param {{sync: Object, source: Object}} claimed
 * @param {{result?: Object, error?: string, commit?: string}} outcome
 * @returns {Promise<void>}
 */
const finishSyncInternal = async ({ sync, source }, { result = null, error = null, commit = null }) => {
    const held = await skillSyncRepository.finishInternal(sync, {
        status: error ? SKILL_SYNC_STATUS.FAILED : SKILL_SYNC_STATUS.SUCCEEDED,
        result,
        error,
    });
    if (!held) {
        logger.warn(`Skill sync ${sync.id}: the claim was lost to another worker; its outcome is not recorded`);
        return;
    }
    await skillSourceRepository.updateInternal(source.id, {
        lastSyncedAt: new Date(),
        lastError: error,
        ...(commit ? { lastCommit: commit } : {}),
    });
    await notifyHub.publish(CHANNELS.SKILL_SYNC_DONE, { syncId: sync.id }).catch(() => {});
};

/**
 * Worker: renew the lease of a claimed sync (called from the worker heartbeat).
 * @param {{sync: Object}} claimed
 * @returns {Promise<boolean>} false when another worker took the sync over
 */
const renewSyncInternal = ({ sync }) => skillSyncRepository.renewInternal(sync);

module.exports = {
    createSource,
    listSources,
    deleteSource,
    requestSync,
    getSync,
    claimNextSyncInternal,
    renewSyncInternal,
    credentialInternal,
    finishSyncInternal,
};
