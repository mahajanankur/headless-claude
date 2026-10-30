'use strict';

/**
 * Manage the secrets file (paths.secretsFile for the current NODE_ENV, mode 0600). Values are never echoed.
 *   npm run secrets:init                      add streamTokenSecret + encryptionKey unless already configured
 *   npm run secrets:set -- claudeOauthToken   read a value from stdin (hidden when interactive)
 *   npm run secrets:set -- values.analytics_rw
 * The target file is printed first. Environment variables (e.g. GW_ENCRYPTION_KEY) take precedence over the file.
 */
const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

const config = require('../config');
const { PATHS } = require('../config/paths');

const FILE = PATHS.secretsFile;
const KEY_PATH =
    /^(claudeOauthToken|anthropicApiKey|streamTokenSecret|encryptionKey|values\.[A-Za-z0-9_.-]+|git\.[A-Za-z0-9_.-]+\.(username|token))$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {});
const save = (data) => fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });

// piped input: read everything, with or without a trailing newline (readline would drop an unterminated line)
const readPiped = () =>
    new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(data.trim()));
        process.stdin.on('error', reject);
    });

const readHidden = (prompt) => {
    if (!process.stdin.isTTY) return readPiped();
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        process.stdout.write(prompt);
        rl._writeToOutput = () => {};
        rl.question('', (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer.trim());
        });
    });
};

const init = () => {
    const data = load();
    for (const key of ['streamTokenSecret', 'encryptionKey']) {
        // never generate a key that is already supplied by the environment: it would be ignored, and
        // if the env var were later removed the generated key could not decrypt existing data
        if (!data[key] && !config.get(`secrets.${key}`)) data[key] = crypto.randomBytes(32).toString('hex');
    }
    save(data);
    process.stdout.write(`Secrets file ready.\n`);
};

const setPath = (data, keyPath, value) => {
    const parts = keyPath.split('.');
    if (parts.some((p) => FORBIDDEN.has(p))) throw new Error(`Refusing key '${keyPath}'.`);
    let node = data;
    parts.slice(0, -1).forEach((p) => {
        node[p] = node[p] && typeof node[p] === 'object' ? node[p] : {};
        node = node[p];
    });
    node[parts[parts.length - 1]] = value;
};

const set = async (keyPath) => {
    if (/^(sk-ant-|gwk_)|^[A-Za-z0-9_-]{40,}$/.test(keyPath || '')) {
        throw new Error(
            'That looks like a secret value, not a key name. Run `npm run secrets:set -- claudeOauthToken` and paste the value at the prompt.\n' +
                'The value is now in your shell history: remove it (e.g. `history -d`) and consider rotating it.',
        );
    }
    if (!keyPath || !KEY_PATH.test(keyPath) || keyPath.split('.').some((p) => FORBIDDEN.has(p))) {
        throw new Error(
            'Usage: npm run secrets:set -- claudeOauthToken | anthropicApiKey | values.<name> | git.<ref>.token',
        );
    }
    const value = await readHidden(`Value for ${keyPath}: `);
    if (!value) throw new Error('Empty value; nothing saved.');
    const data = load();
    setPath(data, keyPath, value);
    save(data);
    process.stdout.write(`Saved ${keyPath}.\n`);
};

const main = async () => {
    const [command, arg] = process.argv.slice(2);
    process.stdout.write(`Secrets file: ${FILE} (NODE_ENV=${config.util.getEnv('NODE_ENV')})\n`);
    try {
        if (command === 'init') init();
        else if (command === 'set') await set(arg);
        else throw new Error('Usage: node scripts/secrets.js init | set <key>');
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
};

main();
