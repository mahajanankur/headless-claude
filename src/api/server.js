'use strict';

/**
 * API process entry point: node src/api/server.js
 * SIGTERM/SIGINT: stop accepting connections, drain, close the database.
 */
const http = require('http');

const config = require('../../config');

const { createApp } = require('./app');
const { attachSocket } = require('./socket');
const { sequelize } = require('../db/models');
const notifyHub = require('../infra/notifyHub');
const { requireSecrets } = require('../infra/secrets');
const getLogger = require('../utils/logger');
const { CHANNELS } = require('../constants/eventTypes');

const logger = getLogger(__filename);

const main = async () => {
    requireSecrets(['streamTokenSecret', 'encryptionKey']);
    await sequelize.authenticate();
    await notifyHub.start([CHANNELS.JOB_EVENTS]);
    const server = http.createServer(createApp());
    const io = attachSocket(server);
    server.listen(config.get('server.port'), () => logger.info(`API listening on :${config.get('server.port')}`));
    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info(`${signal} received; draining`);
        const force = setTimeout(() => process.exit(1), config.get('server.shutdownGraceSec') * 1000);
        force.unref();
        io.close();
        server.close(async () => {
            await notifyHub.stop();
            await sequelize.close();
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
};

main().catch((error) => {
    logger.error(`API failed to start: ${error.message}`, error);
    process.exit(1);
});
