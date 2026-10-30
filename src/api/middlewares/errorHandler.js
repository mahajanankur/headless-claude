'use strict';

const { errorBody } = require('../dtos/response.dto');
const { AppError, NotFoundError, mapDbError } = require('../../utils/AppError');
const getLogger = require('../../utils/logger');
const { API_ERROR } = require('../../constants/apiErrors');

const logger = getLogger(__filename);

/** 404 for unknown routes. */
const notFound = (req, res, next) => next(new NotFoundError(`Route ${req.method} ${req.path} not found.`));

/**
 * Last middleware: AppError messages pass through; anything else is a generic 500 (never stack/SQL).
 * Retry-After is set for 429/503 when the error carries a reset time.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    const requestId = (req.context && req.context.requestId) || null;
    if (err && err.type === 'entity.parse.failed') {
        return res
            .status(400)
            .json(errorBody('Request body is not valid JSON.', API_ERROR.INPUT_INVALID, undefined, requestId));
    }
    if (err && err.type === 'entity.too.large') {
        return res
            .status(413)
            .json(errorBody('Request body is too large.', API_ERROR.INPUT_INVALID, undefined, requestId));
    }
    const error = mapDbError(err);
    if (error instanceof AppError) {
        const resetsAt = error.details && error.details.resetsAt;
        if ([429, 503].includes(error.statusCode) && resetsAt && !res.get('Retry-After')) {
            res.set('Retry-After', String(Math.max(1, Math.ceil((new Date(resetsAt) - Date.now()) / 1000))));
        }
        if (error.statusCode === 503) logger.warn(`Request refused: ${error.message}`);
        else if (error.statusCode >= 500) logger.error(`Request failed: ${error.message}`);
        return res.status(error.statusCode).json(errorBody(error.message, error.code, error.details, requestId));
    }
    logger.error(`Unhandled error: ${err && err.message}`, err instanceof Error ? err : undefined);
    return res.status(500).json(errorBody('Internal server error.', API_ERROR.INTERNAL_ERROR, undefined, requestId));
};

module.exports = { errorHandler, notFound };
