'use strict';

const { buildArgs, availableTools, needsEdits } = require('../../src/worker/argsBuilder');
const { manifestDefaults } = require('../../src/services/skillFolder.service');

const manifest = (over = {}) => ({
    ...manifestDefaults(),
    name: 's',
    prompt: '/s go',
    inputSchema: {},
    instructions: 'Follow these steps.',
    ...over,
});
const paths = { settingsFile: '/m/settings.json', skills: { s: '/skills/s' }, mcpConfigFile: null };
const args = (m, extra = {}) =>
    buildArgs({
        jobId: 'j1',
        manifest: m,
        model: 'haiku',
        paths,
        mode: 'fresh',
        resumeSessionId: null,
        newSessionId: 'sid',
        ...extra,
    });
const flag = (list, name) => list[list.indexOf(name) + 1];

describe('availableTools (--tools allow-list)', () => {
    test('read-only skills get Read only — no Bash, Task, Skill, Cron, web', () => {
        expect(availableTools(manifest())).toEqual(['Read']);
    });

    test('structured output and edits add exactly their tools', () => {
        expect(availableTools(manifest({ outputSchema: { type: 'object' } }))).toEqual(['Read', 'StructuredOutput']);
        expect(availableTools(manifest({ edits: true }))).toEqual(['Read', 'Edit', 'Write', 'NotebookEdit']);
        expect(availableTools(manifest({ changes: 'patch' }))).toContain('Write');
    });

    test('scoped grants add their tool family; MCP tools are not built-ins', () => {
        const tools = availableTools(
            manifest({ allowedTools: ['Bash(psql:*)', 'Bash(git diff:*)', 'WebFetch', 'mcp__db__query'] }),
        );
        expect(tools).toEqual(['Read', 'Bash', 'WebFetch']);
    });
});

describe('buildArgs', () => {
    test('passes the allow-list, permission mode and hardened flags', () => {
        const a = args(manifest({ outputSchema: { type: 'object' } }));
        expect(flag(a, '--tools')).toBe('Read,StructuredOutput');
        expect(flag(a, '--permission-mode')).toBe('dontAsk');
        expect(flag(a, '--setting-sources')).toBe('user');
        expect(flag(a, '--disallowedTools')).toContain('AskUserQuestion');
        expect(flag(a, '--session-id')).toBe('sid');
        expect(flag(a, '--append-system-prompt')).toMatch(/MUST call the StructuredOutput tool/);
        expect(a).not.toContain('--allowedTools');
        expect(a).toContain('--disable-slash-commands');
        expect(a[1]).toBe('go');
    });

    test('injects the SKILL.md instructions as system instructions (slash commands are disabled)', () => {
        const system = flag(args(manifest()), '--append-system-prompt');
        expect(system).toMatch(/# Skill: s\n\nFollow these steps\./);
        expect(system).toMatch(/You can read files; you cannot change them\./);
        expect(flag(args(manifest({ edits: true })), '--append-system-prompt')).toMatch(/under \.\/out\//);
    });

    test('editing skills use acceptEdits; resume uses --resume and the continue prompt', () => {
        expect(needsEdits(manifest({ changes: 'branch' }))).toBe(true);
        const a = args(manifest({ edits: true }), { mode: 'resume', resumeSessionId: 'old' });
        expect(flag(a, '--permission-mode')).toBe('acceptEdits');
        expect(flag(a, '--resume')).toBe('old');
        expect(a).not.toContain('--session-id');
        expect(a[1]).toMatch(/previous run of this job was interrupted/);
    });

    test('the next job in a session resumes with the skill prompt', () => {
        const a = args(manifest(), { resumeSessionId: 'sess' });
        expect(a[1]).toBe('go');
        expect(flag(a, '--resume')).toBe('sess');
    });
});
