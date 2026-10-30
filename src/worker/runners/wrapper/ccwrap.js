#!/usr/bin/env node
'use strict';

/**
 * ccwrap — runs inside the sandbox, next to `claude`. Self-contained: imports nothing from the gateway,
 * because it is copied into the runner image.
 *
 *   node ccwrap.js --run <dir> --control <dir> --timeout <sec> --grace <sec> --max-output <bytes> -- <cmd> [args...]
 *
 * - Appends the child's stdout to <run>/stream.jsonl and stderr to <run>/stderr.log.
 * - Writes <run>/pid.json at start and <run>/exit.json atomically at the end:
 *   { code, signal, reason, startedAt, finishedAt }, reason ∈ null | cancel | timeout | output_limit | budget.
 * - Stops the child (SIGINT → SIGTERM → SIGKILL, `grace` seconds apart) when <control>/cancel appears
 *   (its content is the reason), the timeout passes, the output cap is exceeded, or ccwrap gets SIGTERM/SIGINT.
 * The worker can restart at any time; it re-attaches by reading these files.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const POLL_MS = 500;
const REASONS = new Set(['cancel', 'timeout', 'output_limit', 'budget']);

const parseArgs = (argv) => {
    const sep = argv.indexOf('--');
    if (sep === -1 || sep === argv.length - 1)
        throw new Error('usage: ccwrap --run DIR --control DIR ... -- CMD [ARGS]');
    const opts = {};
    for (let i = 0; i < sep; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
    return {
        runDir: opts.run,
        controlDir: opts.control,
        timeoutMs: Number(opts.timeout || 0) * 1000,
        graceMs: Number(opts.grace || 10) * 1000,
        maxOutput: Number(opts['max-output'] || 0),
        command: argv[sep + 1],
        args: argv.slice(sep + 2),
    };
};

const writeAtomic = (file, data) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
};

const main = () => {
    const opts = parseArgs(process.argv.slice(2));
    const streamFile = path.join(opts.runDir, 'stream.jsonl');
    const out = fs.openSync(streamFile, 'a');
    const err = fs.openSync(path.join(opts.runDir, 'stderr.log'), 'a');
    const startedAt = new Date().toISOString();
    const child = spawn(opts.command, opts.args, { stdio: ['ignore', out, err], env: process.env });
    writeAtomic(path.join(opts.runDir, 'pid.json'), { wrapperPid: process.pid, childPid: child.pid, startedAt });

    let reason = null;
    let escalation = null;
    const stop = (why) => {
        if (reason) return;
        reason = REASONS.has(why) ? why : 'cancel';
        const signals = ['SIGINT', 'SIGTERM', 'SIGKILL'];
        let step = 0;
        const next = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill(signals[step]);
            step += 1;
            if (step < signals.length) escalation = setTimeout(next, opts.graceMs);
        };
        next();
    };

    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    const watcher = setInterval(() => {
        const cancelFile = path.join(opts.controlDir, 'cancel');
        if (fs.existsSync(cancelFile)) stop(fs.readFileSync(cancelFile, 'utf8').trim() || 'cancel');
        else if (Date.now() > deadline) stop('timeout');
        else if (opts.maxOutput && fs.existsSync(streamFile) && fs.statSync(streamFile).size > opts.maxOutput)
            stop('output_limit');
    }, POLL_MS);

    process.on('SIGTERM', () => stop('cancel'));
    process.on('SIGINT', () => stop('cancel'));

    child.on('exit', (code, signal) => {
        clearInterval(watcher);
        clearTimeout(escalation);
        writeAtomic(path.join(opts.runDir, 'exit.json'), {
            code,
            signal,
            reason,
            startedAt,
            finishedAt: new Date().toISOString(),
        });
        process.exit(0);
    });
    child.on('error', (error) => {
        fs.writeSync(err, `ccwrap: failed to start ${opts.command}: ${error.message}\n`);
    });
};

main();
