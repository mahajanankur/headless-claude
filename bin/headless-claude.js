#!/usr/bin/env node
'use strict';

/**
 * headless-claude command line.
 *
 * Server commands run the gateway from this package. Files they create (.env.local, keys, data) live in
 * the working folder: GW_HOME, or the directory you run the command in.
 * Client commands (skills push/sync) only talk to a running gateway over HTTP.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = path.resolve(process.env.GW_HOME || process.cwd());
const DEFAULT_URL = 'http://localhost:4100';

const USAGE = `headless-claude <command>

Run the gateway (working folder: GW_HOME or the current directory)
  setup                      one-time local setup: database, migrations, secrets, API keys
  start                      API and worker together
  api | worker               one process
  migrate [--undo]           database migrations
  app create --name <n> [--skills a,b] [--models haiku,sonnet] [--features x,y] [--admin]
  secrets set <key>          store a gateway secret (value read from stdin or a prompt)

Talk to a running gateway (--url or GW_URL, default ${DEFAULT_URL}; --key or GW_KEY)
  skills push <folder>       pack a skill folder and upload it as a new version
  skills sync <sourceId> [--wait 30]
                             sync a registered git source now

  --version | --help`;

const parseFlags = (argv) => {
    const flags = {};
    const rest = [];
    for (let i = 0; i < argv.length; i += 1) {
        if (!argv[i].startsWith('--')) {
            rest.push(argv[i]);
            continue;
        }
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[key] = true;
        else {
            flags[key] = next;
            i += 1;
        }
    }
    return { flags, rest };
};

const fail = (message) => {
    process.stderr.write(`headless-claude: ${message}\n`);
    process.exit(1);
};

/** Run a node script from this package with the working folder passed on; resolves with its exit code. */
const runNode = (script, args = []) =>
    new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd: ROOT,
            env: { ...process.env, GW_HOME: HOME },
            stdio: 'inherit',
        });
        ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => child.kill(signal)));
        child.on('exit', (code, signal) => resolve(code === null ? (signal === 'SIGINT' ? 130 : 1) : code));
    });

const client = (flags) => {
    const url = String(flags.url || process.env.GW_URL || DEFAULT_URL).replace(/\/+$/, '');
    const key = flags.key || process.env.GW_KEY;
    if (!key || key === true) fail('an API key is required (--key or GW_KEY).');
    return { url, headers: { Authorization: `Bearer ${key}` } };
};

const printResponse = async (res) => {
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = { message: text };
    }
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return res.ok ? 0 : 1;
};

const skillsPush = async (folder, flags) => {
    if (!folder) fail('usage: headless-claude skills push <folder>');
    const dir = path.resolve(folder);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) fail(`${dir} has no manifest.json.`);
    const { pack } = require('../src/utils/skillPackage');
    const { url, headers } = client(flags);
    const body = await pack(dir);
    const res = await fetch(`${url}/api/v1/skills`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/gzip' },
        body,
    });
    return printResponse(res);
};

const skillsSync = async (sourceId, flags) => {
    if (!sourceId) fail('usage: headless-claude skills sync <sourceId> [--wait 30]');
    const { url, headers } = client(flags);
    const wait = flags.wait === undefined ? 30 : Number(flags.wait);
    const res = await fetch(`${url}/api/v1/skill-sources/${encodeURIComponent(sourceId)}/sync?wait=${wait}`, {
        method: 'POST',
        headers,
    });
    return printResponse(res);
};

const appCreate = (args) => runNode(path.join(ROOT, 'scripts/create-app.js'), args);

const main = async () => {
    const [command, ...argv] = process.argv.slice(2);
    const { flags, rest } = parseFlags(argv);
    switch (command) {
        case 'setup':
            return runNode(path.join(ROOT, 'scripts/setup.js'), argv);
        case 'start':
            return runNode(path.join(ROOT, 'scripts/dev.js'));
        case 'api':
            return runNode(path.join(ROOT, 'src/api/server.js'));
        case 'worker':
            return runNode(path.join(ROOT, 'src/worker/index.js'));
        case 'migrate':
            return runNode(require.resolve('sequelize-cli/lib/sequelize'), [
                flags.undo ? 'db:migrate:undo' : 'db:migrate',
            ]);
        case 'app':
            if (rest[0] !== 'create') fail('usage: headless-claude app create --name <name> ...');
            return appCreate(argv.slice(1));
        case 'secrets':
            return runNode(path.join(ROOT, 'scripts/secrets.js'), argv);
        case 'skills':
            if (rest[0] === 'push') return skillsPush(rest[1], flags);
            if (rest[0] === 'sync') return skillsSync(rest[1], flags);
            return fail('usage: headless-claude skills push <folder> | skills sync <sourceId>');
        case '--version':
        case 'version':
            process.stdout.write(`${require('../package.json').version}\n`);
            return 0;
        case undefined:
        case '--help':
        case 'help':
            process.stdout.write(`${USAGE}\n`);
            return 0;
        default:
            return fail(`unknown command '${command}'. Run headless-claude --help.`);
    }
};

main().then(
    (code) => process.exit(code || 0),
    (error) => fail(error.message),
);
