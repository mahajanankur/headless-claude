'use strict';

/** A skill name (manifest.name, folder name, API path). Mirrors the manifest schema's name pattern. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A git branch or tag the gateway passes to git (no leading dash is possible: argv value after --branch). */
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

/** Skill classes: long skills are limited to worker.longJobSlots. */
const SKILL_CLASS = Object.freeze({ QUICK: 'quick', LONG: 'long' });

/** How the gateway delivers code changes after a successful job. */
const CHANGE_MODE = Object.freeze({ NONE: 'none', PATCH: 'patch', BRANCH: 'branch', PR: 'pr' });

/** Which credential a skill's runs use. */
const CREDENTIAL_PROFILE = Object.freeze({ MAX_SUBSCRIPTION: 'max-subscription', API_KEY: 'api-key' });

/** Where a skill comes from. builtin/shared are gateway skills (app_id NULL); upload/git are app-owned. */
const SKILL_SOURCE = Object.freeze({ BUILTIN: 'builtin', SHARED: 'shared', UPLOAD: 'upload', GIT: 'git' });

/** Who owns a skill, as shown by GET /skills. */
const SKILL_OWNER = Object.freeze({ APP: 'app', SHARED: 'shared', BUILTIN: 'builtin' });

/** Why a skill row is disabled (skills.disabled_reason) when the gateway set it. */
const SKILL_DISABLED_REASON = Object.freeze({
    FOLDER_REMOVED: 'skill folder removed',
    DELETED: 'deleted',
    BY_APP: 'disabled by app',
    NO_VERSION: 'no enabled version',
});

/** Status of a git source sync (skill_syncs.status). */
const SKILL_SYNC_STATUS = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
});

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

/**
 * Tool families that run arbitrary code inside the sandbox. An app's own skill may grant them only when an admin
 * turns on skillsShellActive for the app: code in the sandbox can read the Claude credential from the environment.
 */
const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/**
 * Environment names a manifest may never set: they would redirect Claude's API calls (and its credential), load
 * code into node or the shell, or replace what the gateway sets. Names must also match SAFE_ENV_NAME.
 */
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const BLOCKED_ENV_PREFIXES = Object.freeze([
    'ANTHROPIC_',
    'CLAUDE',
    'NODE_',
    'NPM_',
    'LD_',
    'DYLD_',
    'GIT_',
    'BASH_',
    'OTEL_',
    'JAVA_',
    '_JAVA_',
    'JDK_',
    'XDG_',
    'GCONV_',
    'PYTHON',
    'PERL',
    'RUBY',
    'GEM_',
    'BUNDLE_',
    'LUA_',
    'GOFLAGS',
    'GOPATH',
    'GOROOT',
    'GOPROXY',
    'GOENV',
    'GOTOOLCHAIN',
    'CARGO_',
    'RUSTC',
    'RUSTFLAGS',
    'RUSTDOC',
    'RUSTUP_',
    'DOTNET_',
    'COMPLUS_',
    'MALLOC_',
    'SSL',
    'OPENSSL_',
    'GNUTLS_',
    'NSS_',
    'GLIBC_',
    'LOCPATH',
    'NLSPATH',
    'NIX_',
]);
const BLOCKED_ENV_SUFFIXES = Object.freeze(['_PROXY']);
const BLOCKED_ENV_NAMES = Object.freeze([
    'PATH',
    'HOME',
    'SHELL',
    'ENV',
    'TMPDIR',
    'TMP',
    'TEMP',
    'TEMPDIR',
    'PWD',
    'OLDPWD',
    'USER',
    'LOGNAME',
    'IFS',
    'PS4',
    'PROMPT_COMMAND',
    'CDPATH',
    'GLOBIGNORE',
    'HISTFILE',
    'HOSTALIASES',
    'LOCALDOMAIN',
    'RES_OPTIONS',
    'RESOLV_HOST_CONF',
    'SSLKEYLOGFILE',
    'TZDIR',
    'TERMINFO',
    'TERMINFO_DIRS',
    'EDITOR',
    'VISUAL',
    'PAGER',
    'MANPAGER',
    'BROWSER',
    'CURL_HOME',
    'WGETRC',
    'NETRC',
    'GNUPGHOME',
    'SSH_AUTH_SOCK',
    'SSH_ASKPASS',
    'SUDO_ASKPASS',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'KUBECONFIG',
    'LANG',
    'LC_ALL',
    'DISABLE_AUTOUPDATER',
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'PERL5OPT',
    'PERL5LIB',
    'RUBYOPT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
]);

/** Tools every run gets (reading inside the workspace and skill dirs). */
const BASE_TOOLS = Object.freeze(['Read']);

/** Tools added for skills that edit files (edits: true or changes != none). */
const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit']);

module.exports = {
    SKILL_NAME_PATTERN,
    GIT_REF_PATTERN,
    SKILL_CLASS,
    SKILL_SOURCE,
    SKILL_OWNER,
    SKILL_SYNC_STATUS,
    SKILL_DISABLED_REASON,
    CHANGE_MODE,
    CREDENTIAL_PROFILE,
    ATTEMPT_MODE,
    BARE_FILE_TOOLS,
    RESERVED_SKILL_NAMES,
    FORBIDDEN_TOOLS,
    SHELL_TOOLS,
    SAFE_ENV_NAME,
    BLOCKED_ENV_PREFIXES,
    BLOCKED_ENV_SUFFIXES,
    BLOCKED_ENV_NAMES,
    BASE_TOOLS,
    EDIT_TOOLS,
};
