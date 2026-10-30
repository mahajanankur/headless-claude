'use strict';

const config = require('../../config');

const { redactValue } = require('../utils/redactor');
const { JOB_STATUS } = require('../constants/jobStatus');

const MAX_GENERATIONS = config.get('langfuse.maxGenerations');

const toDate = (value) => (value ? new Date(value) : undefined);

/** Claude usage block → LangFuse usageDetails (token counts by type). */
const usageDetails = (usage = {}) => ({
    input: Number(usage.input_tokens || 0),
    output: Number(usage.output_tokens || 0),
    cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0),
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0),
});

/** One generation per assistant message id (a message can span several stream events: keep the last usage). */
const generationsFrom = (events, logContent) => {
    const byId = new Map();
    events
        .filter((e) => e.type === 'assistant' && e.message && e.message.id)
        .forEach((e) => {
            const previous = byId.get(e.message.id);
            const text = (e.message.content || []).filter((b) => b.type === 'text').map((b) => b.text);
            byId.set(e.message.id, {
                id: e.message.id,
                model: e.message.model,
                startTime: previous ? previous.startTime : toDate(e.timestamp),
                endTime: toDate(e.timestamp),
                usageDetails: usageDetails(e.message.usage),
                output: logContent
                    ? redactValue([...(previous && previous.text ? [previous.text] : []), ...text].join('\n'))
                    : undefined,
                text: [...(previous && previous.text ? [previous.text] : []), ...text].join('\n'),
            });
        });
    return [...byId.values()].slice(0, MAX_GENERATIONS).map(({ text: _text, ...g }) => ({ name: 'claude', ...g }));
};

/** Tool calls with their outcome (denied, error, ok); inputs only when the skill allows content. */
const toolEventsFrom = (events, logContent) => {
    const results = new Map();
    events
        .filter((e) => e.type === 'user')
        .flatMap((e) => (e.message && e.message.content) || [])
        .filter((b) => b.type === 'tool_result')
        .forEach((b) => {
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
            results.set(b.tool_use_id, b.is_error ? (/^Permission to use/.test(text) ? 'denied' : 'error') : 'ok');
        });
    return events
        .filter((e) => e.type === 'assistant')
        .flatMap((e) =>
            ((e.message && e.message.content) || [])
                .filter((b) => b.type === 'tool_use')
                .map((b) => ({ block: b, at: e.timestamp })),
        )
        .map(({ block, at }) => ({
            name: `tool:${block.name}`,
            startTime: toDate(at),
            level: results.get(block.id) === 'ok' || !results.has(block.id) ? 'DEFAULT' : 'WARNING',
            metadata: { tool: block.name, outcome: results.get(block.id) || 'no result' },
            input: logContent ? redactValue(block.input) : undefined,
        }));
};

/**
 * Build the LangFuse payload for one finished attempt. Pure: no I/O.
 * Content (inputs, outputs, tool inputs, text) is included only when the skill sets logContent.
 * @param {Object} ctx
 * @param {Object} ctx.job final job row
 * @param {Object} ctx.attempt attempt row (manifest snapshot inside)
 * @param {Object[]} ctx.events parsed stream-json events of the attempt
 * @param {{succeeded: boolean, errorClass: string|null, message: string|null}} ctx.outcome
 * @param {Object} ctx.run run record (result, output, tokenCount, startedActing, actedOutsideWorkspace)
 * @param {string} ctx.status job status after finalizing
 * @returns {{trace: Object, span: Object, generations: Object[], events: Object[]}}
 */
const buildAttemptTrace = ({ job, attempt, events, outcome, run, status }) => {
    const { manifest } = attempt;
    const logContent = Boolean(manifest.logContent);
    const result = run.result || {};
    const failed = !outcome.succeeded;
    return {
        trace: {
            id: job.id,
            name: `job:${job.skillName}`,
            userId: job.appId,
            sessionId: job.sessionId || undefined,
            tags: [job.skillName, job.model, attempt.runtime].filter(Boolean),
            input: logContent ? redactValue(job.input) : { fields: Object.keys(job.input || {}) },
            output: logContent && status === JOB_STATUS.SUCCEEDED ? redactValue(run.output) : { status },
            metadata: { status, skillVersion: attempt.skillVersion, attempts: attempt.n },
        },
        span: {
            id: attempt.id,
            name: `attempt ${attempt.n} (${attempt.mode})`,
            startTime: toDate(attempt.startedAt) || toDate(attempt.createdAt),
            endTime: new Date(),
            level: failed ? 'ERROR' : 'DEFAULT',
            statusMessage: failed ? `${outcome.errorClass}: ${outcome.message || ''}`.slice(0, 500) : undefined,
            metadata: {
                skillVersion: attempt.skillVersion,
                model: job.model,
                numTurns: result.num_turns,
                terminalReason: result.terminal_reason,
                weightedTokens: run.tokenCount,
                listPriceUsd: result.total_cost_usd,
                startedActing: run.startedActing,
                actedOutsideWorkspace: run.actedOutsideWorkspace,
            },
        },
        generations: generationsFrom(events, logContent),
        events: toolEventsFrom(events, logContent),
    };
};

module.exports = { buildAttemptTrace, usageDetails };
