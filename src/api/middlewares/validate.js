'use strict';

const { validationResult } = require('express-validator');

const { ValidationError } = require('../../utils/AppError');

/**
 * Run express-validator chains and throw a ValidationError with every message.
 * @param {Object} req
 * @param {Array} chains
 * @returns {Promise<void>}
 * @throws {ValidationError}
 */
const runValidation = async (req, chains) => {
    await Promise.all(chains.map((chain) => chain.run(req)));
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const list = errors.array({ onlyFirstError: true }).map((e) => ({ field: e.path, message: e.msg }));
        throw new ValidationError(list[0].message, list);
    }
};

module.exports = { runValidation };
