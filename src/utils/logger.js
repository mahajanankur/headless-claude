'use strict';

const { LoggerFactory } = require('motifer');

const config = require('../../config');

const { redact } = require('./redactor');
const { getContext } = require('./requestContext');

const factory = new LoggerFactory('headless-claude', config.get('logging.level'));

const CONTEXT_KEYS = ['requestId', 'appId', 'jobId', 'attemptId'];

const withContext = (message) => {
    const ctx = getContext();
    const tags = CONTEXT_KEYS.filter((k) => ctx[k]).map((k) => `${k}=${ctx[k]}`);
    return redact(tags.length ? `${message} [${tags.join(' ')}]` : String(message));
};

const toSafeError = (error) => {
    const safe = new Error(redact(error.message));
    safe.name = error.name;
    safe.stack = redact(error.stack || '');
    return safe;
};

/**
 * Motifer logger with redaction and request/job context on every line.
 * The error object goes last and only in the deepest layer.
 * @param {string} file usually __filename
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
const getLogger = (file) => {
    const base = factory.getLogger(file);
    return {
        debug: (message) => base.debug(withContext(message)),
        info: (message) => base.info(withContext(message)),
        warn: (message) => base.warn(withContext(message)),
        error: (message, error) =>
            error instanceof Error
                ? base.error(withContext(message), toSafeError(error))
                : base.error(withContext(message)),
    };
};

module.exports = getLogger;
