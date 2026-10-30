'use strict';

/**
 * One-command local setup. Safe to run again: every step checks before it acts.
 *   npm run setup
 * 1. Node >= 20, Claude Code installed
 * 2. .env.local (from .env.example)
 * 3. Postgres reachable (starts `docker compose up -d` when it is not)
 * 4. Migrations for the development and test databases
 * 5. Secrets file (stream-token + encryption keys)
 * 6. Claude credential (asks for a `claude setup-token` token, hidden, and verifies it)
 * 7. Skills validated and registered
 * 8. An admin app and a dev app (every feature on); keys saved to .gateway-keys.local (0600, git-ignored)
 * 9. Optional LangFuse tracing (asks; keys verified against the LangFuse API before saving)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.local');
const KEYS_FILE = path.join(ROOT, '.gateway-keys.local');

const ok = (msg) => process.stdout.write(`  ✓ ${msg}\n`);
const step = (msg) => process.stdout.write(`\n${msg}\n`);
const fail = (msg) => {
    process.stdout.write(`  ✗ ${msg}\n`);
    process.exit(1);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const has = (cmd) => run('/bin/sh', ['-c', `command -v ${cmd}`]).status === 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const askHidden = (prompt) =>
    new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve('');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        process.stdout.write(prompt);
        rl._writeToOutput = () => {};
        return rl.question('', (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer.trim());
        });
    });

const askLine = (prompt) =>
    new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve('');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });

/** Set or replace KEY=value lines in .env.local. */
const setEnvVars = (vars) => {
    let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    Object.entries(vars).forEach(([key, value]) => {
        const line = `${key}=${value}`;
        const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
        text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
    });
    fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
};

const checkPrerequisites = () => {
    step('1. Prerequisites');
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) fail(`Node.js 20+ required (found ${process.versions.node}).`);
    ok(`Node.js ${process.versions.node}`);
    const claude = run('claude', ['--version']);
    if (claude.status !== 0) fail('Claude Code not found. Install it: npm install -g @anthropic-ai/claude-code');
    ok(`Claude Code ${claude.stdout.trim()}`);
};

const ensureEnvFile = () => {
    step('2. Local environment');
    if (fs.existsSync(ENV_FILE)) return ok('.env.local exists');
    fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
    fs.chmodSync(ENV_FILE, 0o600);
    return ok('created .env.local from .env.example');
};

const canConnect = async () => {
    const { Client } = require('pg');
    const config = require('../config');
    const client = new Client({ connectionString: config.get('postgres.url'), connectionTimeoutMillis: 2000 });
    try {
        await client.connect();
        await client.end();
        return true;
    } catch {
        return false;
    }
};

const ensureDatabase = async () => {
    step('3. Database');
    if (await canConnect()) return ok('Postgres reachable');
    if (!has('docker')) fail('Postgres is not reachable and Docker is not installed. Set DATABASE_URL in .env.local.');
    const up = run('docker', ['compose', 'up', '-d'], { stdio: 'inherit' });
    if (up.status !== 0) fail('docker compose up failed (is Docker running? is port 5432 free?).');
    for (let i = 0; i < 30; i += 1) {
        if (await canConnect()) return ok('Postgres started with docker compose');
        await sleep(1000);
    }
    return fail('Postgres did not become reachable within 30 s.');
};

const migrate = () => {
    step('4. Migrations');
    const cli = path.join(ROOT, 'node_modules', '.bin', 'sequelize-cli');
    for (const env of ['development', 'test']) {
        const res = run(cli, ['db:migrate'], { env: { ...process.env, NODE_ENV: env } });
        if (res.status !== 0) fail(`${env} migration failed:\n${res.stdout}${res.stderr}`);
        ok(`${env} database migrated`);
    }
};

const ensureSecrets = () => {
    step('5. Secrets');
    const { PATHS } = require('../config/paths');
    const file = PATHS.secretsFile;
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    let changed = false;
    for (const key of ['streamTokenSecret', 'encryptionKey']) {
        if (!data[key]) {
            data[key] = crypto.randomBytes(32).toString('hex');
            changed = true;
        }
    }
    if (changed) fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    ok(changed ? `created keys in ${path.relative(ROOT, file)}` : 'secrets file ready');
    return { file, data };
};

const tokenWorks = (token) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-auth-'));
    try {
        const res = run('claude', ['auth', 'status'], {
            env: {
                HOME: home,
                CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
                PATH: process.env.PATH,
                CLAUDE_CODE_OAUTH_TOKEN: token,
            },
        });
        return /"loggedIn":\s*true/.test(res.stdout);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
};

const ensureClaudeCredential = async ({ file, data }) => {
    step('6. Claude credential');
    const { getSecrets } = require('../src/infra/secrets');
    const configured = getSecrets(); // file + environment (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)
    if (configured.anthropicApiKey) return ok('Anthropic API key configured');
    if (configured.claudeOauthToken && tokenWorks(configured.claudeOauthToken))
        return ok('Claude token configured and valid');
    process.stdout.write(
        '    Run `claude setup-token` in another terminal and paste the token here (Enter to skip).\n',
    );
    const token = await askHidden('    Token: ');
    if (!token) return ok('skipped — add it later with: npm run secrets:set -- claudeOauthToken');
    if (!tokenWorks(token)) fail('Claude rejected that token. Run `claude setup-token` again.');
    fs.writeFileSync(file, `${JSON.stringify({ ...data, claudeOauthToken: token }, null, 2)}\n`, { mode: 0o600 });
    return ok('Claude token saved and verified');
};

const syncSkills = async () => {
    step('7. Skills');
    const skillService = require('../src/services/skill.service');
    const results = await skillService.syncFromDisk();
    results.forEach((r) =>
        r.enabled ? ok(`skill ${r.name}`) : process.stdout.write(`  ! skill ${r.name} disabled: ${r.error}\n`),
    );
    return results.filter((r) => r.enabled).map((r) => r.name);
};

const ensureApps = async (skills) => {
    step('8. Apps and API keys');
    if (fs.existsSync(KEYS_FILE)) return ok(`keys already in ${path.basename(KEYS_FILE)}`);
    const appService = require('../src/services/app.service');
    const { FEATURES } = require('../src/constants/features');
    const allFeatures = Object.fromEntries(Object.values(FEATURES).map((f) => [f, true]));
    const suffix = crypto.randomBytes(3).toString('hex');
    const admin = await appService.createApp({ name: `admin-${suffix}`, isAdmin: true, allowedSkills: skills });
    const dev = await appService.createApp({
        name: `dev-${suffix}`,
        allowedSkills: skills,
        allowedModels: ['haiku', 'sonnet', 'opus'],
        features: allFeatures,
    });
    fs.writeFileSync(KEYS_FILE, `ADMIN_KEY=${admin.apiKey}\nDEV_KEY=${dev.apiKey}\n`, { mode: 0o600 });
    return ok(`admin and dev apps created; keys saved to ${path.basename(KEYS_FILE)}`);
};

const langfuseKeysWork = async ({ baseUrl, publicKey, secretKey }) => {
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/public/projects`, {
            headers: { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` },
            signal: AbortSignal.timeout(10000),
        });
        return res.ok;
    } catch {
        return false;
    }
};

const askLangfuse = async () => {
    const answer = await askLine(
        '    Enable LangFuse tracing (one trace per job; no prompts or outputs unless a skill opts in)? [y/N] ',
    );
    if (!/^y(es)?$/i.test(answer)) return null;
    const baseUrl = (await askLine('    LangFuse URL [https://cloud.langfuse.com]: ')) || 'https://cloud.langfuse.com';
    const publicKey = await askLine('    Public key (pk-lf-…): ');
    const secretKey = await askHidden('    Secret key (sk-lf-…, hidden): ');
    return { baseUrl, publicKey, secretKey };
};

const ensureObservability = async ({ file }) => {
    step('9. Observability (optional)');
    const config = require('../config');
    const { getSecrets } = require('../src/infra/secrets');
    const current = getSecrets();
    const configured = {
        baseUrl: config.get('langfuse.baseUrl'),
        publicKey: current.langfusePublicKey,
        secretKey: current.langfuseSecretKey,
    };
    if (config.get('langfuse.enabled') && configured.publicKey && (await langfuseKeysWork(configured))) {
        return ok(`LangFuse tracing on (${configured.baseUrl})`);
    }
    const chosen = configured.publicKey && configured.secretKey ? configured : await askLangfuse();
    if (!chosen)
        return ok(
            'LangFuse tracing off (enable later: npm run setup, or LANGFUSE_* variables — see docs/configuration.md)',
        );
    if (!(await langfuseKeysWork(chosen))) fail(`LangFuse rejected those keys at ${chosen.baseUrl}.`);
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(
        file,
        `${JSON.stringify({ ...data, langfusePublicKey: chosen.publicKey, langfuseSecretKey: chosen.secretKey }, null, 2)}\n`,
        {
            mode: 0o600,
        },
    );
    setEnvVars({ LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: chosen.baseUrl });
    return ok(`LangFuse tracing on (${chosen.baseUrl}); keys verified and saved`);
};

const main = async () => {
    process.stdout.write('headless-claude — local setup\n');
    checkPrerequisites();
    ensureEnvFile();
    await ensureDatabase();
    migrate();
    const secrets = ensureSecrets();
    await ensureClaudeCredential(secrets);
    const skills = await syncSkills();
    await ensureApps(skills);
    await ensureObservability(secrets);
    const { sequelize } = require('../src/db/models');
    await sequelize.close();
    process.stdout.write(`\nReady. Start the gateway:   npm run dev
Then try (keys are in ${path.basename(KEYS_FILE)}):
  source ${path.basename(KEYS_FILE)}
  curl -s -X POST localhost:4100/api/v1/chat -H "Authorization: Bearer $DEV_KEY" -H "Content-Type: application/json" -d '{"message":"Hello!","model":"haiku"}'
`);
};

main().catch((error) => {
    process.stdout.write(`\nSetup failed: ${error.message}\n`);
    process.exit(1);
});
