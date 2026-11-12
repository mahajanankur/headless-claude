'use strict';

const { isAllowedSkillEnvName } = require('../../src/utils/envPolicy');
const { buildEnv, buildSettings, buildArgs } = require('../../src/worker/argsBuilder');

describe('skill env names', () => {
    test.each(['TEAM_TOKEN', 'DATABASE_URL', 'AWS_REGION', 'X', 'GITHUB_TOKEN', 'GH_TOKEN', 'GOOGLE_API_KEY'])(
        '%s is allowed',
        (name) => {
            expect(isAllowedSkillEnvName(name)).toBe(true);
        },
    );

    test.each([
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'DYLD_INSERT_LIBRARIES',
        'GIT_ASKPASS',
        'BASH_ENV',
        'HTTPS_PROXY',
        'NO_PROXY',
        'PATH',
        'HOME',
        'PYTHONSTARTUP',
        'JAVA_TOOL_OPTIONS',
        '_JAVA_OPTIONS',
        'GCONV_PATH',
        'HOSTALIASES',
        'XDG_CONFIG_HOME',
        'SSLKEYLOGFILE',
        'PROMPT_COMMAND',
        'TMP',
        'TEMP',
        'GOFLAGS',
        'RUSTC_WRAPPER',
        'lower_case',
        '1ABC',
    ])('%s is refused', (name) => {
        expect(isAllowedSkillEnvName(name)).toBe(false);
    });

    test('buildEnv drops refused names and the gateway values win', () => {
        const env = buildEnv({
            paths: { home: '/h' },
            credential: { claudeOauthToken: 'tok' },
            skillEnv: { TEAM_TOKEN: 'a', ANTHROPIC_BASE_URL: 'https://evil.example.com', HOME: '/x' },
            pathEnv: '/bin',
        });
        expect(env).toMatchObject({ TEAM_TOKEN: 'a', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    test('every run denies the app home and /proc, and ignores MCP config left in the home', () => {
        const paths = {
            meta: '/m',
            run: '/r',
            control: '/c',
            home: '/apps/a/home',
            skills: { s: '/sk' },
            settingsFile: '/m/settings.json',
        };
        const { deny } = buildSettings({ paths, sandboxOn: false }).permissions;
        expect(deny).toEqual(
            expect.arrayContaining(['Read(//apps/a/home/**)', 'Edit(//apps/a/home/**)', 'Read(//proc/**)']),
        );
        const manifest = {
            name: 's',
            prompt: 'p',
            maxTurns: 1,
            allowedTools: [],
            disallowedTools: [],
            mcpServers: {},
            instructions: 'x',
        };
        const args = buildArgs({ jobId: 'j', manifest, model: 'haiku', paths, mode: 'fresh', newSessionId: 'n' });
        expect(args).toContain('--strict-mcp-config');
        expect(args).not.toContain('--mcp-config');
    });
});
