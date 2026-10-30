'use strict';

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');

const config = require('../../config');

const routes = require('./routes');
const { requestId } = require('./middlewares/requestId');
const { perIp } = require('./middlewares/rateLimit');
const { errorHandler, notFound } = require('./middlewares/errorHandler');

/**
 * Build the Express app (no listening; see server.js). Exported for tests.
 * @returns {import('express').Express}
 */
const createApp = () => {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.get('server.trustProxy'));
    app.use(helmet());
    const origins = config.get('server.corsOrigins');
    app.use(cors({ origin: origins.length ? origins : false }));
    app.use(express.json({ limit: config.get('server.bodyLimit') }));
    app.use(requestId);
    app.use(perIp);
    app.use('/api/v1', routes);
    app.use(notFound);
    app.use(errorHandler);
    return app;
};

module.exports = { createApp };
