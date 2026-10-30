'use strict';

const config = require('../../config');

const { redact } = require('../utils/redactor');
const { EVENT_TYPE, READ_ONLY_TOOLS, WORKSPACE_TOOLS } = require('../constants/eventTypes');

const SUMMARY_MAX = config.get('job.eventSummaryMaxChars');

/** What running a tool can affect. */
const TOOL_EFFECT = Object.freeze({ NONE: 'none', WORKSPACE: 'workspace', OUTSIDE: 'outside' });

/**
 * @param {string} name tool name (Bash, Read, mcp__server__tool, ...)
 * @returns {string} TOOL_EFFECT
 */
const toolEffect = (name) => {
    if (READ_ONLY_TOOLS.includes(name)) return TOOL_EFFECT.NONE;
    if (WORKSPACE_TOOLS.includes(name)) return TOOL_EFFECT.WORKSPACE;
    return TOOL_EFFECT.OUTSIDE;
};

/**
 * @param {string} line one stream-json line
 * @returns {Object|null} parsed event, or null when not JSON
 */
const parseLine = (line) => {
    try {
        const event = JSON.parse(line);
        return event && typeof event === 'object' ? event : null;
    } catch {
        return null;
    }
};

const clip = (text) => redact(String(text)).slice(0, SUMMARY_MAX);

const contentBlocks = (event) => (event.message && Array.isArray(event.message.content) ? event.message.content : []);

const assistantRows = (event, logContent) =>
    contentBlocks(event).flatMap((block) => {
        if (block.type === 'tool_use') {
            const detail = logContent ? ` ${clip(JSON.stringify(block.input || {}))}` : '';
            return [{ type: EVENT_TYPE.TOOL_USE, summary: `${block.name}${detail}` }];
        }
        if (block.type === 'text' && block.text) {
            return [
                {
                    type: EVENT_TYPE.ASSISTANT_TEXT,
                    summary: logContent ? clip(block.text) : `text (${block.text.length} chars)`,
                },
            ];
        }
        return [];
    });

const toolResultRows = (event, logContent) =>
    contentBlocks(event)
        .filter((b) => b.type === 'tool_result')
        .map((b) => {
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
            const status = b.is_error ? 'error' : 'ok';
            return {
                type: EVENT_TYPE.TOOL_RESULT,
                summary: logContent ? `${status}: ${clip(text)}` : `${status} (${text.length} chars)`,
            };
        });

const resultSummary = (e) =>
    `${e.subtype}${e.is_error ? ' (error)' : ''}, turns=${e.num_turns}, terminal=${e.terminal_reason || '-'}`;

/**
 * Event rows to store for one stream event. Content (text, tool input/output) only with logContent.
 * @param {Object} event
 * @param {{logContent: boolean}} options
 * @returns {Array<{type: string, summary: string}>}
 */
const toEventRows = (event, { logContent }) => {
    switch (event.type) {
        case 'system':
            return event.subtype === 'init'
                ? [{ type: EVENT_TYPE.INIT, summary: `model=${event.model} claude=${event.claude_code_version}` }]
                : [];
        case 'assistant':
            return assistantRows(event, logContent);
        case 'user':
            return toolResultRows(event, logContent);
        case 'rate_limit_event':
            return [
                {
                    type: EVENT_TYPE.RATE_LIMIT,
                    summary:
                        `${(event.rate_limit_info || {}).status} ${(event.rate_limit_info || {}).rateLimitType || ''}`.trim(),
                },
            ];
        case 'result':
            return [{ type: EVENT_TYPE.RESULT, summary: resultSummary(event) }];
        default:
            return [{ type: EVENT_TYPE.OTHER, summary: String(event.type || 'unknown').slice(0, 60) }];
    }
};

/**
 * Per-message usage (deduplicate by message id: one message can span several events).
 * @param {Object} event
 * @returns {{messageId: string, usage: Object}|null}
 */
const messageUsage = (event) =>
    event.type === 'assistant' && event.message && event.message.usage && event.message.id
        ? { messageId: event.message.id, usage: event.message.usage }
        : null;

/**
 * Tool calls in an assistant event: [{ id, name }].
 * @param {Object} event
 * @returns {Array<{id: string, name: string}>}
 */
const toolUses = (event) =>
    event.type === 'assistant'
        ? contentBlocks(event)
              .filter((b) => b.type === 'tool_use')
              .map((b) => ({ id: b.id, name: b.name }))
        : [];

const DENIED = /^Permission to use \S+ has been denied/;

/**
 * Tool results in a user event: [{ id, denied }]. A denied call never ran, so it has no effect.
 * @param {Object} event
 * @returns {Array<{id: string, denied: boolean}>}
 */
const toolResults = (event) =>
    event.type === 'user'
        ? contentBlocks(event)
              .filter((b) => b.type === 'tool_result')
              .map((b) => {
                  const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
                  return { id: b.tool_use_id, denied: Boolean(b.is_error) && DENIED.test(text.replace(/^"/, '')) };
              })
        : [];

module.exports = { parseLine, toEventRows, toolUses, toolResults, toolEffect, messageUsage, TOOL_EFFECT };
