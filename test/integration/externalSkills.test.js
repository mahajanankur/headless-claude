'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PATHS } = require('../../config/paths');
const { sequelize, assertLocalTestDb } = require('../helpers/db');
const { setupGateway, startWorker, waitForJob, submit } = require('../helpers/gateway');
const appService = require('../../src/services/app.service');
const notifyHub = require('../../src/infra/notifyHub');
const { pack } = require('../../src/utils/skillPackage');
const { ALL_FEATURES } = require('../helpers/gateway');
const { FEATURES } = require('../../src/constants/features');
const { SCOPES } = require('../../src/constants/scopes');

jest.setTimeout(60000);

let gw;
let worker;
let root;

const manifest = (name, version, extra = {}) => ({
    name,
    version,
    description: 'Team skill for tests.',
    defaultModel: 'haiku',
    timeoutSec: 60,
    maxTurns: 5,
    inputSchema: { type: 'object', additionalProperties: true },
    prompt: 'Read ./input.json.',
    edits: true,
    ...extra,
});

/** Write a skill folder and return its gzipped package. */
const skillPackage = async (name, version, { note = `note ${version}`, extra = {}, dir } = {}) => {
    const folder = dir || path.join(root, `${name}-${version}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(folder, '.claude/skills', name, 'references'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest(name, version, extra)));
    fs.writeFileSync(path.join(folder, '.claude/skills', name, 'SKILL.md'), `# ${name}\nFollow the input.\n`);
    fs.writeFileSync(path.join(folder, '.claude/skills', name, 'references/note.md'), note);
    return pack(folder);
};

const upload = (app, buffer) =>
    gw.http.post('/api/v1/skills').set(app.auth).set('Content-Type', 'application/gzip').send(buffer);

const artifactJson = async (app, jobId, name) => {
    const list = await gw.http.get(`/api/v1/jobs/${jobId}/artifacts`).set(app.auth);
    const item = list.body.data.items.find((a) => a.name === name);
    const res = await gw.http
        .get(`/api/v1/artifacts/${item.id}`)
        .set(app.auth)
        .buffer(true)
        .parse((r, cb) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => cb(null, data));
        });
    return JSON.parse(res.body);
};

const makeApp = async (name, features) => {
    const { app, apiKey } = await appService.createApp({ name, allowedSkills: [], allowedModels: ['haiku'], features });
    return { ...app, key: apiKey, auth: { Authorization: `Bearer ${apiKey}` } };
};

beforeAll(() => assertLocalTestDb());
beforeEach(async () => {
    gw = await setupGateway();
    worker = await startWorker();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ext-'));
});
afterEach(async () => {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
});
afterAll(async () => {
    await notifyHub.stop();
    await sequelize.close();
});

describe('uploading app skills', () => {
    test('new version → 201, same again → 200, same version with new content → 409, next version → 201', async () => {
        const v1 = await skillPackage('team-skill', '1.0.0');
        const first = await upload(gw.appA, v1);
        expect(first.status).toBe(201);
        expect(first.body.data).toMatchObject({ name: 'team-skill', version: '1.0.0', status: 'created' });

        // re-packing the same files is the same content (checksum is over files, not archive bytes)
        const again = await upload(gw.appA, await skillPackage('team-skill', '1.0.0'));
        expect(again.status).toBe(200);
        expect(again.body.data.status).toBe('unchanged');

        const changed = await upload(gw.appA, await skillPackage('team-skill', '1.0.0', { note: 'different' }));
        expect(changed.status).toBe(409);
        expect(changed.body.error.code).toBe('SKILL_VERSION_EXISTS');

        expect((await upload(gw.appA, await skillPackage('team-skill', '1.1.0'))).status).toBe(201);
        const skill = await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth);
        expect(skill.body.data).toMatchObject({ name: 'team-skill', version: '1.1.0', owner: 'app' });
        expect(skill.body.data.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);

        const list = await gw.http.get('/api/v1/skills').set(gw.appA.auth);
        expect(list.body.data.items.find((s) => s.name === 'team-skill').owner).toBe('app');
        expect(list.body.data.items.find((s) => s.name === 'fake-skill').owner).toBe('builtin');
    });

    test('rejects unsafe or invalid packages and names', async () => {
        const empty = await gw.http.post('/api/v1/skills').set(gw.appA.auth).set('Content-Type', 'application/gzip');
        expect(empty.body.error.code).toBe('SKILL_PACKAGE_REJECTED');

        const garbage = await upload(gw.appA, Buffer.from('not a tarball'));
        expect(garbage.status).toBe(400);
        expect(garbage.body.error.code).toBe('SKILL_PACKAGE_REJECTED');

        const taken = await upload(gw.appA, await skillPackage('fake-skill', '9.0.0'));
        expect(taken.status).toBe(409);
        expect(taken.body.error.code).toBe('SKILL_NAME_TAKEN');

        const apiKey = await upload(
            gw.appA,
            await skillPackage('paid-skill', '1.0.0', { extra: { credentialProfile: 'api-key' } }),
        );
        expect(apiKey.status).toBe(400);
        expect(apiKey.body.error.code).toBe('SKILL_INVALID');

        const badTools = await upload(
            gw.appA,
            await skillPackage('bad-skill', '1.0.0', { extra: { allowedTools: ['Read'] } }),
        );
        expect(badTools.status).toBe(400);
        expect(badTools.body.error.code).toBe('SKILL_INVALID');
    });

    test('flag off → 404; key without skills:write → 403', async () => {
        const res = await upload(gw.appB, await skillPackage('b-skill', '1.0.0'));
        expect(res.status).toBe(404);
        const { apiKey } = await appService.createApiKey(gw.appA.id, {
            scopes: [SCOPES.SKILLS_READ, SCOPES.JOBS_WRITE],
        });
        const noScope = await gw.http
            .post('/api/v1/skills')
            .set({ Authorization: `Bearer ${apiKey}` })
            .set('Content-Type', 'application/gzip')
            .send(await skillPackage('a-skill', '1.0.0'));
        expect(noScope.status).toBe(403);
    });
});

describe('running app skills', () => {
    test('runs with its own files and its app secret; another app can neither see nor run it', async () => {
        const pkg = await skillPackage('team-skill', '1.0.0', {
            note: 'team reference',
            extra: { env: { TEAM_TOKEN: 'secret:team-token' } },
        });
        expect((await upload(gw.appA, pkg)).status).toBe(201);
        const put = await gw.http.put('/api/v1/secrets/team-token').set(gw.appA.auth).send({ value: 'tok-123456789' });
        expect(put.status).toBe(200);
        expect(JSON.stringify(put.body)).not.toContain('tok-123456789');

        const job = await submit(gw.http, gw.appA, {
            skill: 'team-skill',
            input: { scenario: 'probe', envNames: ['TEAM_TOKEN'] },
        });
        expect(job.status).toBe(202);
        const done = await waitForJob(gw.http, gw.appA, job.body.data.jobId);
        expect(done.status).toBe('succeeded');
        const probe = await artifactJson(gw.appA, done.jobId, 'probe.json');
        expect(probe.env.TEAM_TOKEN).toBe('tok-123456789');
        expect(probe.refs['team-skill']).toBe('team reference');

        // app C has the feature on but does not own the skill: it is neither listed nor runnable
        const appC = await makeApp('app-c', ALL_FEATURES);
        const list = await gw.http.get('/api/v1/skills').set(appC.auth);
        expect(list.body.data.items.map((s) => s.name)).not.toContain('team-skill');
        expect((await submit(gw.http, appC, { skill: 'team-skill', input: {} })).body.error.code).toBe(
            'FORBIDDEN_SKILL',
        );
        const patch = await gw.http.patch('/api/v1/skills/team-skill').set(appC.auth).send({ enabled: false });
        expect(patch.status).toBe(404);
        expect((await gw.http.get('/api/v1/secrets').set(appC.auth)).body.data.items).toEqual([]);
        expect((await gw.http.delete('/api/v1/secrets/team-token').set(appC.auth)).status).toBe(404);

        // the same name in app C is a different skill, and it cannot read app A's secret
        await upload(appC, pkg);
        const jobC = await submit(gw.http, appC, { skill: 'team-skill', input: { scenario: 'probe' } });
        const failedC = await waitForJob(gw.http, appC, jobC.body.data.jobId);
        expect(failedC.status).toBe('failed');
        expect(failedC.error.message).toMatch(/team-token/);
    });

    test('a pinned version, a running job keeps its version, the cache rebuilds', async () => {
        await upload(gw.appA, await skillPackage('team-skill', '1.0.0', { note: 'one' }));
        const slow = await submit(gw.http, gw.appA, { skill: 'team-skill', input: { scenario: 'slow' } });
        await waitForJob(gw.http, gw.appA, slow.body.data.jobId, (j) => j.status === 'running');
        await upload(gw.appA, await skillPackage('team-skill', '2.0.0', { note: 'two' }));
        const slowDone = await waitForJob(gw.http, gw.appA, slow.body.data.jobId);
        expect(slowDone.attempts[0].skillVersion).toBe('1.0.0');

        // cached versions are read-only on purpose; make them writable to remove them
        execFileSync('chmod', ['-R', 'u+w', PATHS.skillCacheDir]);
        fs.rmSync(PATHS.skillCacheDir, { recursive: true, force: true });
        const pinned = await submit(gw.http, gw.appA, {
            skill: 'team-skill',
            skillVersion: '1.0.0',
            input: { scenario: 'probe' },
        });
        const latest = await submit(gw.http, gw.appA, { skill: 'team-skill', input: { scenario: 'probe' } });
        const pinnedDone = await waitForJob(gw.http, gw.appA, pinned.body.data.jobId);
        const latestDone = await waitForJob(gw.http, gw.appA, latest.body.data.jobId);
        expect(pinnedDone.attempts[0].skillVersion).toBe('1.0.0');
        expect((await artifactJson(gw.appA, pinnedDone.jobId, 'probe.json')).refs['team-skill']).toBe('one');
        expect(latestDone.attempts[0].skillVersion).toBe('2.0.0');
        expect((await artifactJson(gw.appA, latestDone.jobId, 'probe.json')).refs['team-skill']).toBe('two');

        const missing = await submit(gw.http, gw.appA, { skill: 'team-skill', skillVersion: '3.0.0', input: {} });
        expect(missing.status).toBe(404);
    });

    test('disabling a version falls back to the previous one; deleting stops new jobs', async () => {
        await upload(gw.appA, await skillPackage('team-skill', '1.0.0'));
        await upload(gw.appA, await skillPackage('team-skill', '1.1.0'));
        const off = await gw.http
            .patch('/api/v1/skills/team-skill/versions/1.1.0')
            .set(gw.appA.auth)
            .send({ enabled: false });
        expect(off.body.data.version).toBe('1.0.0');

        expect((await gw.http.delete('/api/v1/skills/team-skill').set(gw.appA.auth)).status).toBe(200);
        const after = await submit(gw.http, gw.appA, { skill: 'team-skill', input: {} });
        expect(after.status).toBe(403);
        expect((await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth)).status).toBe(403);

        // uploading the name again starts afresh: the old 1.0.0 is gone, so new content under 1.0.0 is accepted
        expect((await upload(gw.appA, await skillPackage('team-skill', '1.0.0', { note: 'fresh' }))).status).toBe(201);
        const fresh = await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth);
        expect(fresh.body.data.versions.map((v) => v.version)).toEqual(['1.0.0']);
        expect((await submit(gw.http, gw.appA, { skill: 'team-skill', input: {} })).status).toBe(202);
    });

    test('a new version or a re-sync never turns back on a skill or version the app turned off', async () => {
        await upload(gw.appA, await skillPackage('team-skill', '1.0.0'));
        await upload(gw.appA, await skillPackage('team-skill', '2.0.0'));
        await gw.http.patch('/api/v1/skills/team-skill/versions/2.0.0').set(gw.appA.auth).send({ enabled: false });
        // re-uploading the unchanged 2.0.0 (what a git re-sync does) keeps it off; 1.0.0 stays the latest
        expect((await upload(gw.appA, await skillPackage('team-skill', '2.0.0'))).body.data.status).toBe('unchanged');
        expect((await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth)).body.data.version).toBe('1.0.0');

        await gw.http.patch('/api/v1/skills/team-skill').set(gw.appA.auth).send({ enabled: false });
        expect((await upload(gw.appA, await skillPackage('team-skill', '3.0.0'))).status).toBe(201);
        const skill = (await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth)).body.data;
        expect(skill).toMatchObject({ enabled: false, disabledReason: 'disabled by app' });
        expect((await submit(gw.http, gw.appA, { skill: 'team-skill', input: {} })).status).toBe(404);

        // turning it back on runs the newest enabled version
        const on = await gw.http.patch('/api/v1/skills/team-skill').set(gw.appA.auth).send({ enabled: true });
        expect(on.body.data).toMatchObject({ enabled: true, version: '3.0.0' });
    });

    test('retention keeps every version of a live skill, so old pins keep working', async () => {
        const { applyRetention } = require('../../src/services/retention.service');
        await upload(gw.appA, await skillPackage('team-skill', '1.0.0'));
        await upload(gw.appA, await skillPackage('team-skill', '2.0.0'));
        await sequelize.query("UPDATE skill_versions SET created_at = now() - interval '3650 days'");
        await applyRetention();
        const pinned = await submit(gw.http, gw.appA, { skill: 'team-skill', skillVersion: '1.0.0', input: {} });
        expect(pinned.status).toBe(202);
    });

    test('an app skill may use only its own skills and gateway skills the app is granted', async () => {
        const appC = await makeApp('app-c', { [FEATURES.SKILLS_MANAGE]: true });
        expect(
            (await upload(appC, await skillPackage('user-skill', '1.0.0', { extra: { uses: ['fake-skill'] } }))).status,
        ).toBe(201);
        const job = await submit(gw.http, appC, { skill: 'user-skill', input: { scenario: 'probe' } });
        const done = await waitForJob(gw.http, appC, job.body.data.jobId);
        expect(done.status).toBe('failed');
        expect(done.error.message).toMatch(/fake-skill/);
        // a skill that can never start fails on its first attempt instead of using up infra retries
        expect(done.attempts).toHaveLength(1);

        await appService.updateApp(appC.id, { allowedSkills: ['fake-skill'] });
        const granted = await submit(gw.http, appC, { skill: 'user-skill', input: { scenario: 'probe' } });
        expect((await waitForJob(gw.http, appC, granted.body.data.jobId)).status).toBe('succeeded');
    });

    test('with skillsManageActive off the app is back to gateway skills only, queued jobs included', async () => {
        await upload(gw.appA, await skillPackage('team-skill', '1.0.0'));
        await worker.stop();
        const queued = await submit(gw.http, gw.appA, { skill: 'team-skill', input: {} });
        expect(queued.status).toBe(202);
        const features = { ...ALL_FEATURES, [FEATURES.SKILLS_MANAGE]: false };
        await appService.updateApp(gw.appA.id, { features });

        expect((await submit(gw.http, gw.appA, { skill: 'team-skill', input: {} })).status).toBe(403);
        const list = await gw.http.get('/api/v1/skills').set(gw.appA.auth);
        expect(list.body.data.items.map((s) => s.name)).not.toContain('team-skill');
        expect((await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth)).status).toBe(403);

        worker = await startWorker();
        const failed = await waitForJob(gw.http, gw.appA, queued.body.data.jobId);
        expect(failed.status).toBe('failed');
        expect(failed.error.message).toMatch(/skillsManageActive/);
    });

    test('the latest version is the highest version number, not the last upload', async () => {
        await upload(gw.appA, await skillPackage('team-skill', '2.0.0'));
        expect((await upload(gw.appA, await skillPackage('team-skill', '1.4.1'))).status).toBe(201);
        const skill = await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth);
        expect(skill.body.data.version).toBe('2.0.0');
        expect((await upload(gw.appA, await skillPackage('team-skill', '10.0.0'))).status).toBe(201);
        const after = await gw.http.get('/api/v1/skills/team-skill').set(gw.appA.auth);
        expect(after.body.data.version).toBe('10.0.0');
    });

    test('a secret ref named like an Object property is not configured', async () => {
        const pkg = await skillPackage('proto-skill', '1.0.0', { extra: { env: { FOO: 'secret:constructor' } } });
        expect((await upload(gw.appA, pkg)).status).toBe(201);
        const job = await submit(gw.http, gw.appA, { skill: 'proto-skill', input: { scenario: 'probe' } });
        const done = await waitForJob(gw.http, gw.appA, job.body.data.jobId);
        expect(done.status).toBe('failed');
        expect(done.error.message).toMatch(/Secret 'constructor' required by the skill is not configured/);
    });
});

describe('what an app skill may do', () => {
    test('no Bash, MCP servers or reserved env names unless an admin allows shell for the app', async () => {
        const appC = await makeApp('app-c', { [FEATURES.SKILLS_MANAGE]: true });
        const refused = async (extra) => {
            const res = await upload(appC, await skillPackage('risky-skill', '1.0.0', { extra }));
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('SKILL_INVALID');
            return res.body.message;
        };
        expect(await refused({ allowedTools: ['Bash(curl:*)'] })).toMatch(/skillsShellActive/);
        expect(await refused({ mcpServers: { x: { command: 'sh', args: ['-c', 'true'] } } })).toMatch(
            /skillsShellActive/,
        );
        // file path rules could read /proc (the Claude credential) or the host: refused even with the shell flag
        for (const rule of ['Read(//proc/self/environ)', 'Read(//**)', 'Write(~/.claude/.claude.json)', 'Edit(../x)']) {
            expect(await refused({ allowedTools: [rule], edits: true })).toMatch(/file path rules/);
        }
        // env names that redirect Claude or load code are refused for every skill, flag or not
        for (const name of [
            'ANTHROPIC_BASE_URL',
            'NODE_OPTIONS',
            'HTTPS_PROXY',
            'CLAUDE_CONFIG_DIR',
            'PATH',
            'lower',
        ]) {
            expect(await refused({ env: { [name]: 'secret:x' } })).toMatch(/env must not set/);
        }

        // an admin allows shell for the app: Bash is accepted (reserved env names still are not)
        await appService.updateApp(appC.id, {
            features: { [FEATURES.SKILLS_MANAGE]: true, [FEATURES.SKILLS_SHELL]: true },
        });
        const bash = await upload(
            appC,
            await skillPackage('risky-skill', '1.0.0', { extra: { allowedTools: ['Bash(ls:*)'] } }),
        );
        expect(bash.status).toBe(201);
        expect(await refused({ env: { ANTHROPIC_BASE_URL: 'secret:x' } })).toMatch(/env must not set/);
        expect(await refused({ allowedTools: ['Read(//proc/**)'] })).toMatch(/file path rules/);

        // taking the flag away again stops the skill, including jobs already queued
        await worker.stop();
        const queued = await submit(gw.http, appC, { skill: 'risky-skill', input: {} });
        expect(queued.status).toBe(202);
        await appService.updateApp(appC.id, { features: { [FEATURES.SKILLS_MANAGE]: true } });
        worker = await startWorker();
        const failed = await waitForJob(gw.http, appC, queued.body.data.jobId);
        expect(failed.status).toBe('failed');
        expect(failed.error.message).toMatch(/Bash/);
    });
});

describe('secrets', () => {
    test('names only, never values; validation and 404', async () => {
        await gw.http.put('/api/v1/secrets/db-url').set(gw.appA.auth).send({ value: 'postgres://u:p@h/db' });
        const list = await gw.http.get('/api/v1/secrets').set(gw.appA.auth);
        expect(list.body.data.items.map((s) => s.name)).toEqual(['db-url']);
        expect(JSON.stringify(list.body)).not.toContain('postgres://');
        expect((await gw.http.put('/api/v1/secrets/db-url').set(gw.appA.auth).send({ value: '' })).status).toBe(400);
        expect((await gw.http.put('/api/v1/secrets/bad name').set(gw.appA.auth).send({ value: 'x' })).status).toBe(400);
        expect((await gw.http.delete('/api/v1/secrets/db-url').set(gw.appA.auth)).status).toBe(200);
        expect((await gw.http.delete('/api/v1/secrets/db-url').set(gw.appA.auth)).status).toBe(404);
        expect((await gw.http.get('/api/v1/secrets').set(gw.appB.auth)).status).toBe(404);
    });
});

describe('git sources', () => {
    const git = (cwd, ...args) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

    const makeRepo = async () => {
        const repo = path.join(root, 'skills-repo');
        fs.mkdirSync(path.join(repo, 'skills'), { recursive: true });
        await skillPackage('git-skill', '1.0.0', { dir: path.join(repo, 'skills', 'git-skill') });
        await skillPackage('other-skill', '1.0.0', { dir: path.join(repo, 'skills', 'other-skill') });
        fs.writeFileSync(path.join(repo, 'skills', 'other-skill', 'manifest.json'), '{broken');
        git(repo, 'init', '-q', '-b', 'main');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'skills');
        return repo;
    };

    test('sync now imports each skill folder, a new commit adds a version, failures are reported', async () => {
        const repo = await makeRepo();
        const created = await gw.http
            .post('/api/v1/skill-sources')
            .set(gw.appA.auth)
            .send({ repoUrl: `file://${repo}`, ref: 'main', path: 'skills' });
        expect(created.status).toBe(201);
        const { sourceId } = created.body.data;

        const first = await gw.http.post(`/api/v1/skill-sources/${sourceId}/sync?wait=20`).set(gw.appA.auth);
        expect(first.status).toBe(200);
        expect(first.body.data).toMatchObject({
            status: 'succeeded',
            added: [{ name: 'git-skill', version: '1.0.0' }],
        });
        expect(first.body.data.failed).toEqual([expect.objectContaining({ name: 'other-skill' })]);

        await skillPackage('git-skill', '1.1.0', { dir: path.join(repo, 'skills', 'git-skill') });
        git(repo, 'commit', '-q', '-am', 'bump');
        const second = await gw.http.post(`/api/v1/skill-sources/${sourceId}/sync`).set(gw.appA.auth);
        expect(second.status).toBe(202);
        const { syncId } = second.body.data;
        let sync;
        for (let i = 0; i < 100; i += 1) {
            sync = (await gw.http.get(`/api/v1/skill-sources/${sourceId}/syncs/${syncId}`).set(gw.appA.auth)).body.data;
            if (sync.status === 'succeeded' || sync.status === 'failed') break;
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(sync.added).toEqual([{ name: 'git-skill', version: '1.1.0' }]);
        const skill = await gw.http.get('/api/v1/skills/git-skill').set(gw.appA.auth);
        expect(skill.body.data.version).toBe('1.1.0');

        const sources = await gw.http.get('/api/v1/skill-sources').set(gw.appA.auth);
        expect(sources.body.data.items[0].lastCommit).toMatch(/^[0-9a-f]{40}$/);

        // other apps never see the source or its syncs
        const appC = await makeApp('app-c', { [FEATURES.SKILLS_MANAGE]: true });
        expect((await gw.http.get(`/api/v1/skill-sources/${sourceId}/syncs/${syncId}`).set(appC.auth)).status).toBe(
            404,
        );
        expect((await gw.http.post(`/api/v1/skill-sources/${sourceId}/sync`).set(appC.auth)).status).toBe(404);
        expect((await gw.http.get('/api/v1/skill-sources').set(appC.auth)).body.data.items).toEqual([]);
    });

    test('concurrent "sync now" requests share one sync; a sync taken over is never overwritten', async () => {
        const skillSourceService = require('../../src/services/skillSource.service');
        const { SkillSync } = require('../../src/db/models');
        const repo = await makeRepo();
        const created = await gw.http
            .post('/api/v1/skill-sources')
            .set(gw.appA.auth)
            .send({ repoUrl: `file://${repo}`, ref: 'main', path: 'skills' });
        const { sourceId } = created.body.data;
        await worker.stop();

        const requests = await Promise.all(
            [1, 2, 3].map(() => gw.http.post(`/api/v1/skill-sources/${sourceId}/sync`).set(gw.appA.auth)),
        );
        expect(requests.map((r) => r.status)).toEqual([202, 202, 202]);
        expect(new Set(requests.map((r) => r.body.data.syncId)).size).toBe(1);

        // worker A claims it, stops renewing; worker B takes it over; A's late outcome is dropped
        const claimedA = await skillSourceService.claimNextSyncInternal('host-a');
        await SkillSync.update(
            { heartbeatAt: new Date(Date.now() - 3600 * 1000) },
            { where: { id: claimedA.sync.id } },
        );
        const claimedB = await skillSourceService.claimNextSyncInternal('host-b');
        expect(claimedB.sync.id).toBe(claimedA.sync.id);
        expect(await skillSourceService.renewSyncInternal(claimedA)).toBe(false);
        expect(await skillSourceService.renewSyncInternal(claimedB)).toBe(true);

        await skillSourceService.finishSyncInternal(claimedB, { result: { added: [], unchanged: [], failed: [] } });
        await skillSourceService.finishSyncInternal(claimedA, { error: 'late failure from the old worker' });
        const row = await SkillSync.findOne({ where: { id: claimedA.sync.id }, raw: true });
        expect(row.status).toBe('succeeded');
        expect(row.error).toBeNull();
    });

    test('a repository that cannot be cloned fails the sync with a reason', async () => {
        const created = await gw.http
            .post('/api/v1/skill-sources')
            .set(gw.appA.auth)
            .send({ repoUrl: `file://${root}/missing-repo` });
        const res = await gw.http
            .post(`/api/v1/skill-sources/${created.body.data.sourceId}/sync?wait=20`)
            .set(gw.appA.auth);
        expect(res.body.data.status).toBe('failed');
        expect(res.body.data.error.code).toBe('SKILL_SOURCE_FAILED');
    });

    test('validation: https only on other hosts, relative path', async () => {
        const bad = await gw.http
            .post('/api/v1/skill-sources')
            .set(gw.appA.auth)
            .send({ repoUrl: 'https://evil.example.com/x.git' });
        expect(bad.status).toBe(400);
        const escape = await gw.http
            .post('/api/v1/skill-sources')
            .set(gw.appA.auth)
            .send({ repoUrl: `file://${root}`, path: '../etc' });
        expect(escape.status).toBe(400);
    });
});

describe('CLI', () => {
    test('skills push packs a folder and uploads it to a running gateway', async () => {
        const { createApp } = require('../../src/api/app');
        const server = createApp().listen(0);
        try {
            const dir = path.join(root, 'cli-skill');
            await skillPackage('cli-skill', '1.0.0', { dir });
            const cli = path.join(__dirname, '../../bin/headless-claude.js');
            const out = await new Promise((resolve, reject) => {
                require('child_process').execFile(
                    process.execPath,
                    [cli, 'skills', 'push', dir],
                    {
                        env: {
                            ...process.env,
                            GW_URL: `http://127.0.0.1:${server.address().port}`,
                            GW_KEY: gw.appA.key,
                        },
                    },
                    (error, stdout) => (error ? reject(error) : resolve(stdout)),
                );
            });
            expect(JSON.parse(out).data).toMatchObject({ name: 'cli-skill', version: '1.0.0', status: 'created' });
        } finally {
            server.close();
        }
    });
});

describe('admin', () => {
    test('re-syncs gateway skills; non-admins get 403', async () => {
        const res = await gw.http.post('/api/v1/admin/skills/sync').set(gw.admin.auth);
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((s) => s.name)).toContain('fake-skill');
        expect((await gw.http.post('/api/v1/admin/skills/sync').set(gw.appA.auth)).status).toBe(403);
    });
});
