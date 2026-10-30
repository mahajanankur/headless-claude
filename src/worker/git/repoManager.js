'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../../../config');
const { PATHS } = require('../../../config/paths');

const { run } = require('../runners/base.runner');

const GIT = config.get('git.bin');
const DEPTH = config.get('git.cloneDepth');
const TIMEOUT_MS = config.get('git.timeoutSec') * 1000;
const ASKPASS = path.join(__dirname, 'askpass.sh');

/** Hardened flags for every git command the gateway runs (decision D24). */
const SAFE_FLAGS = Object.freeze([
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.file.allow=user',
    '-c',
    'submodule.recurse=false',
    '-c',
    'credential.helper=',
    '-c',
    `user.name=${config.get('git.authorName')}`,
    '-c',
    `user.email=${config.get('git.authorEmail')}`,
]);

const gitEnv = (credential) => ({
    PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
    HOME: PATHS.dataDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(credential
        ? {
              GIT_ASKPASS: ASKPASS,
              GW_GIT_USERNAME: credential.username || 'x-access-token',
              GW_GIT_PASSWORD: credential.token,
          }
        : {}),
});

const git = async (args, { credential, cwd } = {}) => {
    const result = await run(GIT, [...SAFE_FLAGS, ...args], {
        env: gitEnv(credential),
        timeout: TIMEOUT_MS,
        cwd: cwd || PATHS.dataDir,
    });
    if (result.code !== 0)
        throw new Error(
            `git ${args.find((a) => !a.startsWith('-')) || ''} failed: ${result.stderr.trim().slice(0, 300)}`,
        );
    return result.stdout;
};

const wt = (repo) => [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`];

/**
 * Directories for a job's repository: the git dir lives outside Claude's workspace, so Claude never sees `.git`.
 * @param {string} jobId
 * @param {string} wsDir
 * @returns {{gitDir: string, workTree: string}}
 */
const repoPaths = (jobId, wsDir) => ({ gitDir: path.join(PATHS.gitDir, jobId), workTree: path.join(wsDir, 'repo') });

/**
 * Shallow-clone into a separate git dir and check out into ws/repo. Re-uses an existing clone.
 * @param {{repoUrl: string, repoRef: string|null, gitDir: string, workTree: string, credential?: Object}} options
 * @returns {Promise<{headSha: string, ref: string}>}
 */
const cloneRepo = async ({ repoUrl, repoRef, gitDir, workTree, credential }) => {
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
        fs.mkdirSync(path.dirname(gitDir), { recursive: true });
        const branchArgs = repoRef ? ['--branch', repoRef] : [];
        await git(['clone', '--bare', '--depth', String(DEPTH), '--no-tags', ...branchArgs, '--', repoUrl, gitDir], {
            credential,
        });
        await git([`--git-dir=${gitDir}`, 'config', 'core.bare', 'false']);
    }
    fs.mkdirSync(workTree, { recursive: true });
    const repo = { gitDir, workTree };
    await git([...wt(repo), 'reset', '--hard', '--quiet', 'HEAD']);
    const headSha = (await git([...wt(repo), 'rev-parse', 'HEAD'])).trim();
    const ref = repoRef || (await git([...wt(repo), 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return { headSha, ref };
};

/**
 * Stage every change in the work tree and return the binary patch against HEAD ('' when unchanged).
 * @param {{gitDir: string, workTree: string}} repo
 * @returns {Promise<string>}
 */
const diffWorkTree = async (repo) => {
    await git([...wt(repo), 'add', '--all', '--', '.']);
    return git([...wt(repo), 'diff', '--cached', '--binary', 'HEAD']);
};

/**
 * Commit staged changes and push them to a new branch.
 * @param {{gitDir: string, workTree: string}} repo
 * @param {{branch: string, message: string, credential?: Object}} options
 * @returns {Promise<string>} the commit sha
 */
const commitAndPush = async (repo, { branch, message, credential }) => {
    await git([...wt(repo), 'commit', '--quiet', '--no-verify', '-m', message]);
    const sha = (await git([...wt(repo), 'rev-parse', 'HEAD'])).trim();
    await git([...wt(repo), 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { credential });
    return sha;
};

/**
 * @param {string} jobId
 * @returns {void}
 */
const removeRepo = (jobId) => fs.rmSync(path.join(PATHS.gitDir, jobId), { recursive: true, force: true });

/**
 * Tracked files of the checkout, one per line (repo-relative). Written into the workspace so read-only skills,
 * which have no directory-listing tool, can find files without Bash.
 * @param {{gitDir: string, workTree: string}} repo
 * @returns {Promise<string>}
 */
const listTrackedFiles = (repo) => git([...wt(repo), 'ls-files']);

module.exports = { repoPaths, cloneRepo, diffWorkTree, commitAndPush, removeRepo, listTrackedFiles, SAFE_FLAGS };
