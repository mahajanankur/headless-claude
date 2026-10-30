'use strict';

const getLogger = require('../utils/logger');

/**
 * Wrap every repository method so a DB error is logged once, with the full error object,
 * at the deepest layer (rules N7), then rethrown unchanged.
 * @param {string} name repository name used in log lines
 * @param {Object<string, Function>} methods
 * @returns {Object<string, Function>}
 */
const withErrorLogging = (name, methods) => {
    const logger = getLogger(name);
    return Object.fromEntries(
        Object.entries(methods).map(([key, fn]) => [
            key,
            async (...args) => {
                try {
                    return await fn(...args);
                } catch (error) {
                    logger.error(`Error in ${name}.${key}: ${error.message}`, error);
                    throw error;
                }
            },
        ]),
    );
};

/**
 * Guard for app-facing repository methods (rules N3, §7).
 * @param {string} appId
 * @returns {void}
 * @throws {Error} when appId is missing
 */
const requireAppId = (appId) => {
    if (!appId) throw new Error('appId is required');
};

module.exports = { withErrorLogging, requireAppId };
