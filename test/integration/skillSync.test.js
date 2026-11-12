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
    test('a removed gateway skill frees its name for an app; the folder coming back sits beside it', async () => {
        const appService = require('../../src/services/app.service');
        const { pack } = require('../../src/utils/skillPackage');
        writeSkill('alpha-skill', manifest('alpha-skill'));
        writeSkill('beta-skill', manifest('beta-skill'));
        await skillService.syncFromDisk(root);
        const { app } = await appService.createApp({ name: 'team', allowedSkills: [] });
        const buffer = await pack(path.join(root, 'alpha-skill'));
        await expect(skillService.addVersion({ appId: app.id, buffer })).rejects.toMatchObject({
            code: 'SKILL_NAME_TAKEN',
        });

        fs.rmSync(path.join(root, 'alpha-skill'), { recursive: true });
        await skillService.syncFromDisk(root);
        expect(await skillService.addVersion({ appId: app.id, buffer })).toMatchObject({ status: 'created' });

        // the folder coming back registers again for every app; the app that owns the name keeps its own
        writeSkill('alpha-skill', manifest('alpha-skill'));
        const results = await skillService.syncFromDisk(root);
        expect(results.find((r) => r.name === 'alpha-skill')).toMatchObject({ enabled: true });
        const gateway = await skillRepository.findByName('alpha-skill');
        expect(gateway.enabled).toBe(true);
        const owner = { ...app, features: { skillsManageActive: true } };
        expect((await skillService.resolveForJob(owner, 'alpha-skill')).skillId).not.toBe(gateway.id);
    });

    test('a skill whose built-in folder was removed can move to the shared folder', async () => {
        const { SKILL_SOURCE } = require('../../src/constants/skill');
        const builtinDir = path.join(root, 'builtin');
        const sharedDir = path.join(root, 'shared');
        fs.mkdirSync(builtinDir);
        fs.mkdirSync(sharedDir);
        const move = (name, dir) => {
            fs.mkdirSync(path.join(dir, name, '.claude', 'skills', name), { recursive: true });
            fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify(manifest(name)));
            fs.writeFileSync(path.join(dir, name, '.claude', 'skills', name, 'SKILL.md'), '# skill');
        };
        move('alpha-skill', builtinDir);
        move('keep-skill', builtinDir);
        await skillService.syncFromDisk(builtinDir, SKILL_SOURCE.BUILTIN);

        fs.rmSync(path.join(builtinDir, 'alpha-skill'), { recursive: true });
        await skillService.syncFromDisk(builtinDir, SKILL_SOURCE.BUILTIN);
        move('alpha-skill', sharedDir);
        const [result] = await skillService.syncFromDisk(sharedDir, SKILL_SOURCE.SHARED);
        expect(result).toMatchObject({ name: 'alpha-skill', enabled: true });
        expect(result.error).toBeUndefined();
        const skill = await skillRepository.findByName('alpha-skill');
        expect(skill).toMatchObject({ source: SKILL_SOURCE.SHARED, enabled: true });

        // a live skill of the other source still keeps its name
        move('keep-skill', sharedDir);
        const shared = await skillService.syncFromDisk(sharedDir, SKILL_SOURCE.SHARED);
        expect(shared.find((r) => r.name === 'keep-skill').error).toMatch(/already used by a builtin skill/);
    });

    test('a broken gateway skill keeps its name; a shipped built-in name is never free', async () => {
        const appService = require('../../src/services/app.service');
        const { pack } = require('../../src/utils/skillPackage');
        const { app } = await appService.createApp({ name: 'team', allowedSkills: [] });
        writeSkill('alpha-skill', manifest('alpha-skill'));
        await skillService.syncFromDisk(root);
        const buffer = await pack(path.join(root, 'alpha-skill'));
        fs.writeFileSync(path.join(root, 'alpha-skill', 'manifest.json'), '{broken');
        await skillService.syncFromDisk(root);
        expect((await skillRepository.findByName('alpha-skill')).enabled).toBe(false);
        await expect(skillService.addVersion({ appId: app.id, buffer })).rejects.toMatchObject({
            code: 'SKILL_NAME_TAKEN',
        });

        // fake-skill ships in the test package's skills folder: refused even though it was never synced
        writeSkill('fake-skill', manifest('fake-skill'));
        const shipped = await pack(path.join(root, 'fake-skill'));
        await expect(skillService.addVersion({ appId: app.id, buffer: shipped })).rejects.toMatchObject({
            code: 'SKILL_NAME_TAKEN',
        });
    });

    test('files outside the package (README, .DS_Store) do not change the checksum', async () => {
        const { checksumFolder } = require('../../src/services/skillFolder.service');
        const { pack, unpack } = require('../../src/utils/skillPackage');
        writeSkill('alpha-skill', manifest('alpha-skill'));
        fs.writeFileSync(path.join(root, 'alpha-skill', 'README.md'), 'not packaged');
        fs.writeFileSync(path.join(root, 'alpha-skill', '.DS_Store'), 'x');
        const [result] = await skillService.syncFromDisk(root);
        expect(result.enabled).toBe(true);
        const stored = await skillRepository.findByName('alpha-skill');
        const out = path.join(os.tmpdir(), `gw-unpacked-${process.pid}`);
        try {
            await unpack(await pack(path.join(root, 'alpha-skill')), out, { maxUnpackedBytes: 1e6, maxFiles: 50 });
            expect(await checksumFolder(out)).toBe(stored.checksum);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });

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
