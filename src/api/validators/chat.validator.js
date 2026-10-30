'use strict';

const { body, query } = require('express-validator');

const config = require('../../../config');

const { runValidation } = require('../middlewares/validate');
const { onlyFields, uuidParam } = require('./common.validator');

const WAIT_MAX = config.get('job.waitMaxSec');

module.exports = {
    send: (req) =>
        runValidation(req, [
            onlyFields(['message', 'sessionId', 'model']),
            body('message')
                .isString()
                .isLength({ min: 1, max: 20000 })
                .withMessage('Message (message) must be 1-20000 characters.'),
            body('sessionId').optional().isUUID().withMessage('Chat (sessionId) must be a UUID.'),
            body('model')
                .optional()
                .isString()
                .isLength({ min: 1, max: 60 })
                .withMessage('Model (model) must be a model name.'),
            query('wait')
                .optional()
                .isInt({ min: 0, max: WAIT_MAX })
                .withMessage(`Wait (wait) must be between 0 and ${WAIT_MAX} seconds.`)
                .toInt(),
        ]),
    sessionId: (req) => runValidation(req, [uuidParam('id', 'Chat')]),
};
