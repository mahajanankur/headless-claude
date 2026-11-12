'use strict';

const { body, query } = require('express-validator');

const config = require('../../../config');

const { runValidation } = require('../middlewares/validate');
const { onlyFields, uuidParam } = require('./common.validator');

const WAIT_MAX = config.get('skills.syncWaitMaxSec');
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

module.exports = {
    create: (req) =>
        runValidation(req, [
            onlyFields(['repoUrl', 'ref', 'path', 'credentialSecret']),
            body('repoUrl').isString().isLength({ min: 1, max: 2000 }).withMessage('Repository (repoUrl) is required.'),
            body('ref')
                .optional({ values: 'null' })
                .isString()
                .isLength({ min: 1, max: 200 })
                .withMessage('Ref (ref) must be a branch or tag name.'),
            body('path')
                .optional()
                .isString()
                .isLength({ max: 300 })
                .withMessage('Path (path) must be a relative folder.'),
            body('credentialSecret')
                .optional({ values: 'null' })
                .matches(SECRET_NAME)
                .withMessage('Credential secret (credentialSecret) must be the name of one of your secrets.'),
        ]),
    sourceId: (req) => runValidation(req, [uuidParam('id', 'Source')]),
    sync: (req) =>
        runValidation(req, [
            uuidParam('id', 'Source'),
            query('wait')
                .optional()
                .isInt({ min: 0, max: WAIT_MAX })
                .withMessage(`Wait (wait) must be between 0 and ${WAIT_MAX} seconds.`)
                .toInt(),
        ]),
    syncId: (req) => runValidation(req, [uuidParam('id', 'Source'), uuidParam('syncId', 'Sync')]),
    SECRET_NAME,
};
