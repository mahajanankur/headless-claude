'use strict';

const config = require('../../../config');

const { followJob } = require('../../services/jobFeed.service');
const validator = require('../validators/jobs.validator');

const HEARTBEAT_MS = config.get('stream.heartbeatSec') * 1000;
const MAX_CONNECTION_MS = config.get('auth.streamMaxConnectionSec') * 1000;

const lastEventId = (req) => {
    const raw = req.get('Last-Event-ID') || req.query.after;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
};

/** GET /jobs/:id/stream — Server-Sent Events; resumes from Last-Event-ID. */
const stream = async (req, res, next) => {
    let unsubscribe = null;
    try {
        await validator.jobId(req);
        const write = (chunk) => !res.writableEnded && res.write(chunk);
        unsubscribe = await followJob(
            { jobId: req.params.id, appId: req.context.appId, afterId: lastEventId(req) },
            {
                onEvents: (rows) =>
                    rows.forEach((row) => write(`id: ${row.id}\nevent: job-event\ndata: ${JSON.stringify(row)}\n\n`)),
                onEnd: (status) => {
                    write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
                    res.end();
                },
            },
        );
    } catch (error) {
        return next(error);
    }
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`retry: 3000\n\n`);
    const heartbeat = setInterval(() => !res.writableEnded && res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const cap = setTimeout(() => res.end(), MAX_CONNECTION_MS);
    req.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(cap);
        unsubscribe();
    });
    return undefined;
};

module.exports = { stream };
