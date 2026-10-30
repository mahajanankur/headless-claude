'use strict';

/** Success envelope used by every endpoint (rules §12). */
class Response {
    /**
     * @param {boolean} success
     * @param {string} message
     * @param {*} data
     * @param {string} requestId
     */
    constructor(success, message, data, requestId) {
        Object.assign(this, { success, message, data: data === undefined ? null : data, requestId });
    }
}

/**
 * Error envelope.
 * @param {string} message
 * @param {string} code
 * @param {*} details
 * @param {string} requestId
 * @returns {Object}
 */
const errorBody = (message, code, details, requestId) => ({
    success: false,
    message,
    error: { code, ...(details === undefined ? {} : { details }) },
    requestId,
});

module.exports = { Response, errorBody };
