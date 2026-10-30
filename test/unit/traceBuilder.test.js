'use strict';

const { buildAttemptTrace } = require('../../src/services/trace.service');

const usage = (n) => ({
    input_tokens: n,
    output_tokens: n,
    cache_read_input_tokens: 10 * n,
    cache_creation_input_tokens: 0,
});
const events = [
    { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' },
    {
        type: 'assistant',
        timestamp: '2026-10-29T10:00:00Z',
        message: {
            id: 'm1',
            model: 'claude-haiku-5-5',
            usage: usage(1),
            content: [{ type: 'text', text: 'secret plan' }],
        },
    },
    {
        type: 'assistant',
        timestamp: '2026-10-29T10:00:01Z',
        message: {
            id: 'm1',
            model: 'claude-haiku-5-5',
            usage: usage(5),
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf x' } }],
        },
    },
    {
        type: 'user',
        message: {
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 't1',
                    is_error: true,
                    content: 'Permission to use Bash has been denied because …',
                },
            ],
        },
    },
    {
        type: 'assistant',
        timestamp: '2026-10-29T10:00:02Z',
        message: {
            id: 'm2',
            model: 'claude-haiku-5-5',
            usage: usage(2),
            content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } }],
        },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    { type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.01 },
];
const base = (manifest = {}) => ({
    job: {
        id: 'j1',
        appId: 'a1',
        skillName: 'repo-review',
        model: 'haiku',
        sessionId: 's1',
        input: { repoUrl: 'https://x', token: 'abc' },
    },
    attempt: {
        id: 'att1',
        n: 1,
        mode: 'fresh',
        runtime: 'local',
        skillVersion: '1.2.0',
        startedAt: '2026-10-29T09:59:59Z',
        manifest,
    },
    events,
    outcome: { succeeded: true, errorClass: null, message: null },
    run: {
        result: events[6],
        output: { summary: 'private findings' },
        tokenCount: 42,
        startedActing: false,
        actedOutsideWorkspace: false,
    },
    status: 'succeeded',
});

describe('buildAttemptTrace', () => {
    test('one trace per job, grouped by session, one span per attempt', () => {
        const { trace, span } = buildAttemptTrace(base());
        expect(trace).toMatchObject({
            id: 'j1',
            name: 'job:repo-review',
            userId: 'a1',
            sessionId: 's1',
            tags: ['repo-review', 'haiku', 'local'],
        });
        expect(span).toMatchObject({
            id: 'att1',
            name: 'attempt 1 (fresh)',
            level: 'DEFAULT',
            metadata: { numTurns: 3, weightedTokens: 42, listPriceUsd: 0.01 },
        });
    });

    test('one generation per assistant message, with the latest usage for that message', () => {
        const { generations } = buildAttemptTrace(base());
        expect(generations.map((g) => g.id)).toEqual(['m1', 'm2']);
        expect(generations[0].usageDetails).toEqual({
            input: 5,
            output: 5,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
        });
        expect(generations[0].model).toBe('claude-haiku-5-5');
    });

    test('tool events record denied calls as warnings', () => {
        const { events: toolEvents } = buildAttemptTrace(base());
        expect(toolEvents.map((e) => [e.name, e.metadata.outcome, e.level])).toEqual([
            ['tool:Bash', 'denied', 'WARNING'],
            ['tool:Read', 'ok', 'DEFAULT'],
        ]);
    });

    test('no content is sent unless the skill sets logContent', () => {
        const payload = JSON.stringify(buildAttemptTrace(base()));
        expect(payload).not.toMatch(/secret plan|rm -rf|private findings|abc/);
        expect(buildAttemptTrace(base()).trace.input).toEqual({ fields: ['repoUrl', 'token'] });
        const withContent = buildAttemptTrace(base({ logContent: true }));
        expect(withContent.trace.output).toEqual({ summary: 'private findings' });
        expect(withContent.generations[0].output).toMatch(/secret plan/);
        expect(withContent.events[0].input).toEqual({ command: 'rm -rf x' });
    });

    test('failed attempts are marked ERROR with the class', () => {
        const { span } = buildAttemptTrace({
            ...base(),
            outcome: { succeeded: false, errorClass: 'timeout', message: 'too slow' },
            status: 'timed_out',
        });
        expect(span).toMatchObject({ level: 'ERROR', statusMessage: 'timeout: too slow' });
    });
});
