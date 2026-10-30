'use strict';

const { toolUses, toolResults, toolEffect, TOOL_EFFECT } = require('../../src/worker/streamParser');

// exact wording observed from Claude Code 2.1.312 in dontAsk mode
const DENIAL =
    "Permission to use Bash has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools";

const assistant = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const user = (blocks) => ({ type: 'user', message: { content: blocks } });

describe('streamParser tool accounting', () => {
    test('extracts tool calls with ids', () => {
        expect(
            toolUses(
                assistant([
                    { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
                    { type: 'text', text: 'x' },
                ]),
            ),
        ).toEqual([{ id: 't1', name: 'Bash' }]);
    });

    test('a permission denial is recognised; a failed command is not a denial', () => {
        const results = toolResults(
            user([
                { type: 'tool_result', tool_use_id: 't1', is_error: true, content: DENIAL },
                { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'grep: no such file' },
                { type: 'tool_result', tool_use_id: 't3', content: 'ok' },
            ]),
        );
        expect(results).toEqual([
            { id: 't1', denied: true },
            { id: 't2', denied: false },
            { id: 't3', denied: false },
        ]);
    });

    test('tool effects', () => {
        expect(toolEffect('Read')).toBe(TOOL_EFFECT.NONE);
        expect(toolEffect('StructuredOutput')).toBe(TOOL_EFFECT.NONE);
        expect(toolEffect('Write')).toBe(TOOL_EFFECT.WORKSPACE);
        expect(toolEffect('Bash')).toBe(TOOL_EFFECT.OUTSIDE);
        expect(toolEffect('mcp__db__write')).toBe(TOOL_EFFECT.OUTSIDE);
    });
});
