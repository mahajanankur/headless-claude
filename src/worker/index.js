'use strict';

/**
 * Worker process entry point: node src/worker/index.js
 * SIGTERM/SIGINT stop claiming and detach; running attempts continue and are re-attached on restart.
 */
const { sequelize } = require('../db/models');
const { requireSecrets } = require('../infra/secrets');
const { Worker } = require('./worker');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

const main = async () => {
    requireSecrets(['encryptionKey']);
    const worker = new Worker();
    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info(`${signal} received; stopping worker`);
        await worker.stop();
        await sequelize.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    await worker.start();
};

main().catch((error) => {
    logger.error(`Worker failed to start: ${error.message}`, error);
    process.exit(1);
});
