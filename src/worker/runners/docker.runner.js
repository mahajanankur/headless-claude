'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../../../config');

const { run } = require('./base.runner');

const { chownTree } = require('../../utils/safeFs');

const IMAGE = config.get('runner.dockerImage');
const NETWORK = config.get('runner.dockerNetwork');
const CONTAINER_CCWRAP = config.get('runner.containerCcwrapPath');
const CONTAINER_NODE = config.get('runner.containerNodeBin');
const CONFIGURED_USER = config.get('runner.dockerUser');

const IN = Object.freeze({
    ws: '/workspace',
    run: '/gw/run',
    control: '/gw/control',
    meta: '/gw/meta',
    home: '/home/claude',
    skills: '/gw/skills',
});

const containerUser = () => CONFIGURED_USER || `${process.getuid()}:${process.getgid()}`;

/**
 * When the worker runs as root and the container runs as another numeric uid:gid, hand that user what it must
 * write (run/, the workspace with any cloned repo, the app's Claude home) and the read-only mounts it must read
 * (meta/, control/). Without this the container cannot write its stream or exit record on Linux hosts.
 * @param {Object} dirs
 * @returns {void}
 */
const grantContainerAccess = (dirs) => {
    const match = /^(\d+):(\d+)$/.exec(CONFIGURED_USER);
    if (!match || process.getuid() !== 0) return;
    const [uid, gid] = [Number(match[1]), Number(match[2])];
    if (uid === 0) return;
    [dirs.runDir, dirs.wsDir, dirs.homeDir].forEach((dir) => chownTree(dir, uid, gid));
    [dirs.metaDir, dirs.controlDir].forEach((dir) => fs.chownSync(dir, uid, gid));
};

/**
 * Paths inside the container.
 * @param {Object} dirs
 * @param {Object<string, string>} skills
 * @returns {Object}
 */
const sandboxPaths = (dirs, skills) => ({
    ws: IN.ws,
    run: IN.run,
    control: IN.control,
    meta: IN.meta,
    home: IN.home,
    skills: Object.fromEntries(Object.keys(skills).map((name) => [name, `${IN.skills}/${name}`])),
    settingsFile: `${IN.meta}/settings.json`,
    mcpConfigFile: dirs.mcpConfigFile ? `${IN.meta}/mcp.json` : null,
});

const mounts = (dirs, skills) =>
    [
        ['-v', `${dirs.wsDir}:${IN.ws}`],
        ['-v', `${dirs.runDir}:${IN.run}`],
        ['-v', `${dirs.controlDir}:${IN.control}:ro`],
        ['-v', `${dirs.metaDir}:${IN.meta}:ro`],
        ['-v', `${dirs.homeDir}:${IN.home}`],
        ...Object.entries(skills).map(([name, dir]) => ['-v', `${dir}:${IN.skills}/${name}:ro`]),
    ].flat();

/**
 * `docker run` arguments: one locked-down container per attempt (decision D3).
 * @param {Object} spec
 * @returns {string[]}
 */
const runArgs = ({ dirs, skills, envFile, args, wrapArgs, labels, name }) => [
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    name,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--user',
    containerUser(),
    '--read-only',
    '--tmpfs',
    `/tmp:rw,nosuid,size=${config.get('runner.tmpfsSize')}`,
    '--memory',
    config.get('runner.memoryMax'),
    '--memory-swap',
    config.get('runner.memoryMax'),
    '--cpus',
    String(config.get('runner.cpus')),
    '--pids-limit',
    String(config.get('runner.pidsLimit')),
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--network',
    NETWORK,
    '--env-file',
    envFile,
    ...mounts(dirs, skills),
    '-w',
    IN.ws,
    IMAGE,
    CONTAINER_NODE,
    CONTAINER_CCWRAP,
    ...wrapArgs,
    '--',
    config.get('runner.containerClaudeBin'),
    ...args,
];

/**
 * @param {Object} spec { dirs, skills, envFile, args, wrapArgs, labels, name }
 * @returns {Promise<{kind: string, name: string, containerId: string}>}
 * @throws {Error} when docker refuses to start the container
 */
const start = async (spec) => {
    grantContainerAccess(spec.dirs);
    const { stdout, stderr, code } = await run('docker', runArgs(spec));
    if (code !== 0) throw new Error(`docker run failed: ${stderr.trim().slice(0, 300)}`);
    return { kind: 'docker', name: spec.name, containerId: stdout.trim() };
};

/**
 * @param {{name: string}} handle
 * @returns {Promise<boolean>}
 */
const isAlive = async (handle) => {
    const { stdout, code } = await run('docker', ['inspect', '-f', '{{.State.Running}}', handle.name]);
    return code === 0 && stdout.trim() === 'true';
};

/**
 * @param {{name: string}} handle
 * @returns {Promise<void>}
 */
const destroy = async (handle) => {
    await run('docker', ['rm', '-f', handle.name]);
};

module.exports = {
    name: 'docker',
    sandboxOn: false,
    usesEnvFile: true,
    sandboxPaths,
    start,
    isAlive,
    destroy,
    runArgs,
    grantContainerAccess,
    IN,
    path,
};
