'use strict';

/** Skill classes: long skills are limited to worker.longJobSlots. */
const SKILL_CLASS = Object.freeze({ QUICK: 'quick', LONG: 'long' });

/** How the gateway delivers code changes after a successful job. */
const CHANGE_MODE = Object.freeze({ NONE: 'none', PATCH: 'patch', BRANCH: 'branch', PR: 'pr' });

/** Which credential a skill's runs use. */
const CREDENTIAL_PROFILE = Object.freeze({ MAX_SUBSCRIPTION: 'max-subscription', API_KEY: 'api-key' });

/** How an attempt starts: a fresh session or resuming the previous attempt's session. */
const ATTEMPT_MODE = Object.freeze({ FRESH: 'fresh', RESUME: 'resume' });

/** Bare file tools grant access to every file on the host (verified); never allowed in a manifest. */
const BARE_FILE_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Commands and skills bundled with Claude Code (observed in 2.1.312's init event). A gateway skill with one of
 * these names would be shadowed by the bundled one, which brings its own tool grants (verified with code-review).
 */
const RESERVED_SKILL_NAMES = Object.freeze([
    'agents',
    'auto-mode-setup',
    'autocompact',
    'batch',
    'claude-api',
    'clear',
    'code-review',
    'color',
    'compact',
    'config',
    'context',
    'dataviz',
    'debug',
    'doctor',
    'effort',
    'fast',
    'fewer-permission-prompts',
    'focus',
    'goal',
    'heapdump',
    'init',
    'insights',
    'list-agents',
    'loop',
    'mcp',
    'model',
    'output-style',
    'plugin-authoring',
    'recap',
    'reload-plugins',
    'reload-skills',
    'rename',
    'review',
    'run',
    'run-skill-generator',
    'security-review',
    'simplify',
    'team-onboarding',
    'update-config',
    'usage',
    'verify',
    'workflow-launch-exec',
]);

/** Tools a manifest may never grant: they let a job escalate (skills carry their own grants) or act on its own schedule. */
const FORBIDDEN_TOOLS = Object.freeze([
    'Skill',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'Monitor',
    'SendMessage',
    'EnterWorktree',
    'ExitWorktree',
    'TaskStop',
    'ListAgents',
]);

/** Tools every run gets (reading inside the workspace and skill dirs). */
const BASE_TOOLS = Object.freeze(['Read']);

/** Tools added for skills that edit files (edits: true or changes != none). */
const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit']);

module.exports = {
    SKILL_CLASS,
    CHANGE_MODE,
    CREDENTIAL_PROFILE,
    ATTEMPT_MODE,
    BARE_FILE_TOOLS,
    RESERVED_SKILL_NAMES,
    FORBIDDEN_TOOLS,
    BASE_TOOLS,
    EDIT_TOOLS,
};
