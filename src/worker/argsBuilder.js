'use strict';

const config = require('../../config');

const { CHANGE_MODE, ATTEMPT_MODE, BASE_TOOLS, EDIT_TOOLS } = require('../constants/skill');

const PERMISSION_MODE = config.get('llm.permissionMode');
const EDIT_PERMISSION_MODE = config.get('llm.editPermissionMode');
const SETTING_SOURCES = config.get('llm.settingSources');
const ALWAYS_DISALLOWED = config.get('llm.alwaysDisallowedTools');
const RETENTION_DAYS = config.get('scheduler.eventsRetentionDays');

const RESUME_PROMPT =
    'The previous run of this job was interrupted before it finished. Continue the task from where you left off, ' +
    'without repeating actions that already completed, and finish with the required output.';

/**
 * Does this skill create or edit files (permission mode acceptEdits)?
 * @param {Object} manifest
 * @returns {boolean}
 */
const needsEdits = (manifest) => Boolean(manifest.edits) || manifest.changes !== CHANGE_MODE.NONE;

const preamble = (jobId, manifest) =>
    [
        `You are running as unattended job ${jobId} in headless-claude. Nobody can answer questions;`,
        'make reasonable decisions and finish. The request is in ./input.json.',
        needsEdits(manifest)
            ? 'Write any files meant for the caller under ./out/.'
            : 'You can read files; you cannot change them.',
        manifest.repo ? 'The repository is checked out at ./repo; ./repo-files.txt lists its tracked files.' : '',
        manifest.outputSchema
            ? 'When you are done you MUST call the StructuredOutput tool with your final answer.'
            : '',
    ]
        .filter(Boolean)
        .join(' ');

/**
 * System instructions: the gateway preamble, then the skill's SKILL.md body (injected by the gateway because
 * slash commands are disabled, so no bundled command or skill can run), then the manifest's appendSystemPrompt.
 * @param {string} jobId
 * @param {Object} manifest the attempt's snapshot (instructions come from SKILL.md at sync time)
 * @returns {string}
 */
const systemPrompt = (jobId, manifest) =>
    [
        preamble(jobId, manifest),
        manifest.instructions ? `# Skill: ${manifest.name}\n\n${manifest.instructions}` : '',
        manifest.appendSystemPrompt || '',
    ]
        .filter(Boolean)
        .join('\n\n');

/**
 * The user message. Older prompts started with "/<name>"; slash commands are disabled, so that token is dropped.
 * @param {Object} manifest
 * @returns {string}
 */
const userPrompt = (manifest) =>
    manifest.prompt.replace(new RegExp(`^/${manifest.name}(\\s+|$)`), '').trim() || 'Do the task.';

/**
 * Settings file written read-only for every attempt (rules §11 "Building each run").
 * Paths are as seen inside the sandbox.
 * @param {{paths: Object, sandboxOn: boolean}} options
 * @returns {Object}
 */
const buildSettings = ({ paths, sandboxOn }) => ({
    permissions: {
        deny: [
            `Read(/${paths.meta}/**)`,
            `Edit(/${paths.meta}/**)`,
            `Read(/${paths.run}/**)`,
            `Edit(/${paths.run}/**)`,
            `Edit(/${paths.control}/**)`,
            `Edit(/${paths.home}/.claude/settings.json)`,
            ...Object.values(paths.skills).map((dir) => `Edit(/${dir}/**)`),
        ],
    },
    sandbox: { enabled: sandboxOn, failIfUnavailable: sandboxOn, allowUnsandboxedCommands: false },
    cleanupPeriodDays: RETENTION_DAYS,
    includeCoAuthoredBy: false,
});

/**
 * Environment for the Claude process: built from scratch, never inherited (rules N11).
 * @param {Object} options
 * @param {Object} options.paths sandbox paths
 * @param {{claudeOauthToken?: string, anthropicApiKey?: string}} options.credential exactly one is set
 * @param {Object<string, string>} options.skillEnv resolved manifest secrets
 * @param {string} options.pathEnv PATH inside the sandbox
 * @param {string} [options.egressProxy]
 * @returns {Object<string, string>}
 */
const buildEnv = ({ paths, credential, skillEnv, pathEnv, egressProxy }) => {
    const env = {
        ...skillEnv,
        HOME: paths.home,
        CLAUDE_CONFIG_DIR: `${paths.home}/.claude`,
        PATH: pathEnv,
        LANG: 'C.UTF-8',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    if (credential.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = credential.claudeOauthToken;
    if (credential.anthropicApiKey) env.ANTHROPIC_API_KEY = credential.anthropicApiKey;
    if (egressProxy)
        Object.assign(env, { HTTPS_PROXY: egressProxy, HTTP_PROXY: egressProxy, NO_PROXY: 'localhost,127.0.0.1' });
    return env;
};

const joinTools = (tools) => [...new Set(tools)].join(',');

/**
 * The only built-in tools that exist in the session (--tools). Everything else — Task, Skill, Cron, Monitor,
 * SendMessage, worktrees, web tools not granted — is absent, so neither the model nor a bundled skill can use it.
 * MCP tools come from --mcp-config and are not part of this list.
 * @param {Object} manifest
 * @returns {string[]}
 */
const availableTools = (manifest) => {
    const granted = manifest.allowedTools
        .map((rule) => String(rule).split('(')[0])
        .filter((t) => !t.startsWith('mcp__'));
    return [
        ...new Set([
            ...BASE_TOOLS,
            ...(needsEdits(manifest) ? EDIT_TOOLS : []),
            ...(manifest.outputSchema ? ['StructuredOutput'] : []),
            ...granted,
        ]),
    ];
};

/**
 * Command-line arguments for `claude` (no shell; passed to spawn as an array).
 * @param {Object} options
 * @param {string} options.jobId
 * @param {Object} options.manifest the attempt's manifest snapshot
 * @param {string} options.model
 * @param {Object} options.paths sandbox paths (settings file, skill dirs)
 * @param {string} options.mode ATTEMPT_MODE: resume continues an interrupted attempt with RESUME_PROMPT
 * @param {string|null} options.resumeSessionId Claude session to resume (retry resume, or the job's session)
 * @param {string} options.newSessionId session id for a fresh conversation
 * @returns {string[]}
 */
const buildArgs = ({ jobId, manifest, model, paths, mode, resumeSessionId, newSessionId }) => {
    const prompt = mode === ATTEMPT_MODE.RESUME ? RESUME_PROMPT : userPrompt(manifest);
    const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
        '--max-turns',
        String(manifest.maxTurns),
        '--permission-mode',
        needsEdits(manifest) ? EDIT_PERMISSION_MODE : PERMISSION_MODE,
        '--setting-sources',
        SETTING_SOURCES,
        '--disable-slash-commands',
        '--settings',
        paths.settingsFile,
        '--append-system-prompt',
        systemPrompt(jobId, manifest),
        '--tools',
        joinTools(availableTools(manifest)),
        '--disallowedTools',
        joinTools([...ALWAYS_DISALLOWED, ...manifest.disallowedTools]),
    ];
    Object.values(paths.skills).forEach((dir) => args.push('--add-dir', dir));
    if (manifest.allowedTools.length) args.push('--allowedTools', joinTools(manifest.allowedTools));
    if (manifest.outputSchema) args.push('--json-schema', JSON.stringify(manifest.outputSchema));
    if (paths.mcpConfigFile) args.push('--mcp-config', paths.mcpConfigFile, '--strict-mcp-config');
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    else args.push('--session-id', newSessionId);
    return args;
};

module.exports = { buildArgs, buildEnv, buildSettings, needsEdits, availableTools, userPrompt, RESUME_PROMPT };
