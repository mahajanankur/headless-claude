'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run fn with log context (requestId, appId, jobId, attemptId) attached to every log line inside it.
 * @param {Object} context
 * @param {Function} fn
 * @returns {*}
 */
const runWithContext = (context, fn) => storage.run({ ...(storage.getStore() || {}), ...context }, fn);

/** @returns {Object} the current log context, or {} */
const getContext = () => storage.getStore() || {};

module.exports = { runWithContext, getContext };
