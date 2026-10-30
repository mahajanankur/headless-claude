'use strict';

/**
 * Run the API and the worker together for local development, with prefixed output.
 *   npm run dev
 * Ctrl-C stops both. If either exits, the other is stopped too.
 */
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROCESSES = [
    { name: 'api   ', script: 'src/api/server.js' },
    { name: 'worker', script: 'src/worker/index.js' },
];

const children = PROCESSES.map(({ name, script }) => {
    const child = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = (stream, out) =>
        stream.on('data', (chunk) =>
            String(chunk)
                .split('\n')
                .filter(Boolean)
                .forEach((line) => out.write(`[${name}] ${line}\n`)),
        );
    prefix(child.stdout, process.stdout);
    prefix(child.stderr, process.stderr);
    return { name, child };
});

let stopping = false;
const stopAll = (code) => {
    if (stopping) return;
    stopping = true;
    children.forEach(({ child }) => child.exitCode === null && child.kill('SIGTERM'));
    setTimeout(() => process.exit(code), 3000).unref();
};

children.forEach(({ name, child }) =>
    child.on('exit', (code) => {
        if (!stopping) process.stderr.write(`[${name.trim()}] exited with code ${code}; stopping\n`);
        stopAll(code || 0);
    }),
);
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
