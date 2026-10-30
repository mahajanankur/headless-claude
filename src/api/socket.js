'use strict';

const { Server } = require('socket.io');

const config = require('../../config');

const { resolveStreamIdentity } = require('./middlewares/streamAuth');
const { followJob } = require('../services/jobFeed.service');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

const MAX_CONNECTION_MS = config.get('auth.streamMaxConnectionSec') * 1000;
const MAX_SUBSCRIPTIONS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const subscribe = async (socket, subscriptions, { jobId, after } = {}) => {
    if (!UUID.test(String(jobId))) return socket.emit('job-error', { jobId, message: 'Job (jobId) must be a UUID.' });
    if (socket.data.identity.tokenJobId && socket.data.identity.tokenJobId !== jobId) {
        return socket.emit('job-error', { jobId, message: 'This stream token is for a different job.' });
    }
    if (subscriptions.has(jobId) || subscriptions.size >= MAX_SUBSCRIPTIONS) return undefined;
    try {
        const unsubscribe = await followJob(
            { jobId, appId: socket.data.identity.appId, afterId: Number(after) || 0 },
            {
                onEvents: (rows) => socket.emit('job-event', { jobId, events: rows }),
                onEnd: (status) => {
                    socket.emit('job-end', { jobId, status });
                    subscriptions.delete(jobId);
                },
            },
        );
        subscriptions.set(jobId, unsubscribe);
    } catch (error) {
        socket.emit('job-error', { jobId, message: error.message });
    }
    return undefined;
};

/**
 * Socket.IO on namespace /jobs. Handshake auth: { token } (stream token) or { apiKey }.
 * Client: emit('subscribe', { jobId, after? }) → 'job-event' { jobId, events }, 'job-end' { jobId, status }.
 * @param {import('http').Server} httpServer
 * @returns {Server}
 */
const attachSocket = (httpServer) => {
    const origins = config.get('server.corsOrigins');
    const io = new Server(httpServer, { serveClient: false, cors: origins.length ? { origin: origins } : undefined });
    const jobs = io.of('/jobs');
    jobs.use(async (socket, next) => {
        try {
            const { token, apiKey } = socket.handshake.auth || {};
            socket.data.identity = await resolveStreamIdentity({
                token,
                apiKey,
                origin: socket.handshake.headers.origin,
            });
            return next();
        } catch (error) {
            return next(new Error(error.message));
        }
    });
    jobs.on('connection', (socket) => {
        const subscriptions = new Map();
        const cap = setTimeout(() => socket.disconnect(true), MAX_CONNECTION_MS);
        socket.on('subscribe', (payload) => subscribe(socket, subscriptions, payload));
        socket.on('unsubscribe', ({ jobId } = {}) => {
            const off = subscriptions.get(jobId);
            if (off) off();
            subscriptions.delete(jobId);
        });
        socket.on('disconnect', () => {
            clearTimeout(cap);
            subscriptions.forEach((off) => off());
        });
    });
    logger.info('Socket.IO attached on namespace /jobs');
    return io;
};

module.exports = { attachSocket };
