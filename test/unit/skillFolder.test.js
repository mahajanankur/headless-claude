'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSkillFolder, listSkillFolders, manifestDefaults } = require('../../src/services/skillFolder.service');

const REPO_SKILLS = path.join(__dirname, '../../skills');
const tempRoots = [];

afterAll(() => tempRoots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const makeSkill = (name, manifest, { withSkillMd = true } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-skill-'));
    tempRoots.push(root);
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.claude', 'skills', name), { recursive: true });
    if (manifest !== undefined) {
        const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
        fs.writeFileSync(path.join(dir, 'manifest.json'), body);
    }
    if (withSkillMd) fs.writeFileSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'), '# skill');
    return dir;
};

const valid = (name) => ({ name, version: '1.0.0', description: 'd', prompt: 'p', inputSchema: { type: 'object' } });

describe('readSkillFolder', () => {
    test('the shipped repo-review skill is valid', async () => {
        const r = await readSkillFolder(path.join(REPO_SKILLS, 'repo-review'));
        expect(r.error).toBeUndefined();
        expect(r.manifest.allowedTools).toEqual([]);
        expect(r.checksum).toHaveLength(64);
    });

    test('applies defaults', async () => {
        const r = await readSkillFolder(makeSkill('demo-skill', valid('demo-skill')));
        expect(r.manifest.class).toBe('quick');
        expect(r.manifest.changes).toBe('none');
    });

    test.each([
        ['missing manifest', undefined, {}, /manifest.json missing/],
        ['bad json', '{nope', {}, /not valid JSON/],
        ['schema violation', { name: 'x-skill' }, {}, /manifest invalid/],
        ['missing SKILL.md', null, { withSkillMd: false }, /missing .claude\/skills/],
    ])('rejects %s', async (_label, manifest, opts, pattern) => {
        const body = manifest === null ? valid('x-skill') : manifest;
        expect((await readSkillFolder(makeSkill('x-skill', body, opts))).error).toMatch(pattern);
    });

    test('rejects folder/name mismatch', async () => {
        expect((await readSkillFolder(makeSkill('a-skill', valid('b-skill')))).error).toMatch(/does not match folder/);
    });

    test('listSkillFolders returns sorted folders and [] for a missing directory', async () => {
        expect(listSkillFolders('/nonexistent-gw-skills')).toEqual([]);
        expect(listSkillFolders(REPO_SKILLS)).toContain(path.join(REPO_SKILLS, 'repo-review'));
    });

    test('rejects manifests whose input or output schema does not compile', async () => {
        const bad = { ...valid('s-skill'), outputSchema: { type: 'objekt' } };
        expect((await readSkillFolder(makeSkill('s-skill', bad))).error).toMatch(
            /outputSchema is not a valid JSON schema/,
        );
    });

    test('partial nested objects keep their defaults, and defaults are never shared', async () => {
        const a = (await readSkillFolder(makeSkill('n-skill', { ...valid('n-skill'), network: {} }))).manifest;
        const b = (await readSkillFolder(makeSkill('n-skill', valid('n-skill')))).manifest;
        expect(a.network.allowedHosts).toEqual([]);
        expect(a.allowedTools).not.toBe(b.allowedTools);
        expect(manifestDefaults().env).not.toBe(manifestDefaults().env);
    });

    test('checksum covers every file in the skill folder', async () => {
        const dir = makeSkill('c-skill', valid('c-skill'));
        const before = (await readSkillFolder(dir)).checksum;
        fs.writeFileSync(path.join(dir, '.claude', 'skills', 'c-skill', 'helper.sh'), 'echo hi');
        expect((await readSkillFolder(dir)).checksum).not.toBe(before);
    });

    test('captures the SKILL.md body (without frontmatter) as the injected instructions', async () => {
        expect((await readSkillFolder(path.join(REPO_SKILLS, 'repo-review'))).manifest.instructions).toMatch(
            /^You are running as an automated/,
        );
    });

    test('rejects an empty SKILL.md', async () => {
        const dir = makeSkill('m-skill', valid('m-skill'));
        fs.writeFileSync(path.join(dir, '.claude', 'skills', 'm-skill', 'SKILL.md'), '---\nname: m-skill\n---\n');
        expect((await readSkillFolder(dir)).error).toMatch(/no instructions/);
    });

    test('rejects names of Claude Code built-in commands (they shadow the skill)', async () => {
        expect((await readSkillFolder(makeSkill('code-review', valid('code-review')))).error).toMatch(
            /built-in command/,
        );
    });

    test('rejects tools that let a job escalate (Skill, Cron, …)', async () => {
        const r = await readSkillFolder(
            makeSkill('e-skill', { ...valid('e-skill'), allowedTools: ['Skill', 'Bash(git:*)'] }),
        );
        expect(r.error).toMatch(/must not contain Skill/);
    });

    test('rejects allowed-tools in SKILL.md frontmatter (grants belong in the manifest)', async () => {
        const dir = makeSkill('g-skill', valid('g-skill'));
        fs.writeFileSync(
            path.join(dir, '.claude', 'skills', 'g-skill', 'SKILL.md'),
            '---\nname: g-skill\nallowed-tools: Bash(git:*)\n---\nbody',
        );
        expect((await readSkillFolder(dir)).error).toMatch(/must not declare allowed-tools/);
    });

    test('rejects bare file tools (rules N13)', async () => {
        const r = await readSkillFolder(
            makeSkill('t-skill', { ...valid('t-skill'), allowedTools: ['Read', 'Bash(git:*)'] }),
        );
        expect(r.error).toMatch(/bare file tools \(Read\)/);
    });
});
