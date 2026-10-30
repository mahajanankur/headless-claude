'use strict';

const { body } = require('express-validator');

const config = require('../../../config');

const { runValidation } = require('../middlewares/validate');
const { onlyFields, uuidParam, NAME } = require('./common.validator');

const MAX_TTL = config.get('sessions.maxTtlHours');

module.exports = {
    create: (req) =>
        runValidation(req, [
            onlyFields(['name', 'ttlHours']),
            body('name')
                .optional()
                .matches(NAME)
                .withMessage('Name (name) must be 1-100 letters, digits, spaces, dots, dashes or underscores.'),
            body('ttlHours')
                .optional()
                .isInt({ min: 1, max: MAX_TTL })
                .withMessage(`TTL (ttlHours) must be between 1 and ${MAX_TTL}.`)
                .toInt(),
        ]),
    sessionId: (req) => runValidation(req, [uuidParam('id', 'Session')]),
};
