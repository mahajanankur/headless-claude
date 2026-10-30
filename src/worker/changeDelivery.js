'use strict';

const config = require('../../config');

const { getSecrets } = require('../infra/secrets');
const { repoPaths, diffWorkTree, commitAndPush } = require('./git/repoManager');
const { ensurePullRequest } = require('./git/github');
const { storeArtifact } = require('./artifactStore');
const { CHANGE_MODE } = require('../constants/skill');
const { DELIVERY_STATUS } = require('../constants/delivery');

const MAX_PATCH_BYTES = config.get('job.maxPatchBytes');

const credentialFor = (app) => (app.gitCredentialRef ? getSecrets().git[app.gitCredentialRef] || null : null);

const branchName = (job, attempt) => `gw/${job.skillName}/${job.id.slice(0, 8)}-a${attempt.n}`;

const pushAndMaybePr = async ({ job, attempt, manifest, app, repo, patchArtifact }) => {
    const credential = credentialFor(app);
    const branch = branchName(job, attempt);
    await commitAndPush(repo, { branch, message: `${job.skillName}: changes from job ${job.id}`, credential });
    if (manifest.changes !== CHANGE_MODE.PR)
        return { status: DELIVERY_STATUS.DELIVERED, branch, artifacts: [patchArtifact] };
    if (!credential) throw new Error(`No git credential configured for app (gitCredentialRef) to open a pull request.`);
    const prUrl = await ensurePullRequest({
        repoUrl: job.repoUrl,
        head: branch,
        base: job.repoRef,
        title: `${job.skillName}: automated changes (${job.id.slice(0, 8)})`,
        body: `Opened by headless-claude for job \`${job.id}\`.`,
        token: credential.token,
    });
    return { status: DELIVERY_STATUS.DELIVERED, branch, prUrl, artifacts: [patchArtifact] };
};

/**
 * Deliver code changes from ws/repo after a successful job (patch, branch or pr). The gateway runs git;
 * Claude never holds push credentials. Never throws: failures are returned as a FAILED status with the patch kept.
 * @param {{job: Object, attempt: Object, manifest: Object, app: Object, wsDir: string}} ctx
 * @returns {Promise<{status: string, error?: string, branch?: string, prUrl?: string, artifacts: Object[]}>}
 */
const deliverChanges = async ({ job, attempt, manifest, app, wsDir }) => {
    if (manifest.changes === CHANGE_MODE.NONE || !job.repoUrl)
        return { status: DELIVERY_STATUS.NOT_APPLICABLE, artifacts: [] };
    const repo = repoPaths(job.id, wsDir);
    let patchArtifact = null;
    try {
        const patch = await diffWorkTree(repo);
        if (!patch.trim()) return { status: DELIVERY_STATUS.NO_CHANGES, artifacts: [] };
        if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error(`Patch exceeds ${MAX_PATCH_BYTES} bytes.`);
        patchArtifact = storeArtifact(job.id, 'changes.patch', Buffer.from(patch));
        if (manifest.changes === CHANGE_MODE.PATCH)
            return { status: DELIVERY_STATUS.DELIVERED, artifacts: [patchArtifact] };
        return await pushAndMaybePr({ job, attempt, manifest, app, repo, patchArtifact });
    } catch (error) {
        return {
            status: DELIVERY_STATUS.FAILED,
            error: String(error.message).slice(0, 500),
            artifacts: patchArtifact ? [patchArtifact] : [],
        };
    }
};

module.exports = { deliverChanges, branchName };
