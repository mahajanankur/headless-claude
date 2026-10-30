'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sequelize, assertLocalTestDb, truncateAll } = require('../helpers/db');
const skillService = require('../../src/services/skill.service');
const skillRepository = require('../../src/repositories/skill.repository');

const REPO_SKILLS = path.join(__dirname, '../../skills');
let root;

const writeSkill = (name, manifest) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'), '# skill');
};
const manifest = (name, version = '1.0.0') => ({
    name,
    version,
    description: 'd',
    prompt: 'p',
    inputSchema: { type: 'object' },
});

beforeAll(() => assertLocalTestDb());

beforeEach(async () => {
    await truncateAll();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-skills-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

afterAll(() => sequelize.close());

describe('skill sync', () => {
    test('registers the shipped skills', async () => {
        const results = await skillService.syncFromDisk(REPO_SKILLS);
        expect(results).toContainEqual({ name: 'repo-review', enabled: true, error: undefined });
        const { version } = require('../../skills/repo-review/manifest.json');
        expect(await skillService.resolveSkill('repo-review')).toMatchObject({ name: 'repo-review', version });
    });

    test('updates versions, disables invalid and removed skills', async () => {
        writeSkill('alpha-skill', manifest('alpha-skill'));
        writeSkill('beta-skill', manifest('beta-skill'));
        await skillService.syncFromDisk(root);

        writeSkill('alpha-skill', manifest('alpha-skill', '1.1.0'));
        fs.writeFileSync(path.join(root, 'beta-skill', 'manifest.json'), '{broken');
        writeSkill('gamma-skill', manifest('gamma-skill'));
        await skillService.syncFromDisk(root);
        expect((await skillRepository.findByName('alpha-skill')).version).toBe('1.1.0');
        const beta = await skillRepository.findByName('beta-skill');
        expect(beta.enabled).toBe(false);
        expect(beta.version).toBe('1.0.0');

        fs.rmSync(path.join(root, 'gamma-skill'), { recursive: true });
        await skillService.syncFromDisk(root);
        expect((await skillRepository.findByName('gamma-skill')).disabledReason).toBe('skill folder removed');
    });

    test('an empty or missing skills directory fails and disables nothing', async () => {
        writeSkill('alpha-skill', manifest('alpha-skill'));
        await skillService.syncFromDisk(root);
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-empty-'));
        await expect(skillService.syncFromDisk(empty)).rejects.toThrow(/refusing to sync/);
        await expect(skillService.syncFromDisk(path.join(empty, 'missing'))).rejects.toThrow(/refusing to sync/);
        fs.rmSync(empty, { recursive: true, force: true });
        expect((await skillRepository.findByName('alpha-skill')).enabled).toBe(true);
    });

    test('resolveSkill and getSkillForApp enforce availability and permission', async () => {
        writeSkill('alpha-skill', manifest('alpha-skill'));
        await skillService.syncFromDisk(root);
        await expect(skillService.resolveSkill('missing-skill')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
        await expect(skillService.getSkillForApp({ allowedSkills: [] }, 'alpha-skill')).rejects.toMatchObject({
            code: 'FORBIDDEN_SKILL',
        });
        expect(await skillService.listSkillsForApp({ allowedSkills: ['alpha-skill'] })).toHaveLength(1);
    });
});
