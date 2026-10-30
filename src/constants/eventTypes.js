'use strict';

/** Types stored in job_events.type. */
const EVENT_TYPE = Object.freeze({
    STATUS: 'status',
    INIT: 'init',
    ASSISTANT_TEXT: 'assistant_text',
    TOOL_USE: 'tool_use',
    TOOL_RESULT: 'tool_result',
    RATE_LIMIT: 'rate_limit',
    API_RETRY: 'api_retry',
    RESULT: 'result',
    WARNING: 'warning',
    OTHER: 'other',
});

/** Postgres LISTEN/NOTIFY channels. */
const CHANNELS = Object.freeze({
    JOB_EVENTS: 'gw_job_events',
    JOB_QUEUED: 'gw_job_queued',
    JOB_CANCEL: 'gw_job_cancel',
});

/** Tools that do not change anything; using only these never marks an attempt as having acted. */
const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebSearch', 'StructuredOutput']);

/** Tools whose effects stay inside the workspace (file tools are confined to cwd + --add-dir). */
const WORKSPACE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

module.exports = { EVENT_TYPE, CHANNELS, READ_ONLY_TOOLS, WORKSPACE_TOOLS };
