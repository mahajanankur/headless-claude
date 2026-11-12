'use strict';

const { body, param } = require('express-validator');

const config = require('../../../config');

const { runValidation } = require('../middlewares/validate');
const { onlyFields } = require('./common.validator');
const { SECRET_NAME } = require('./skillSources.validator');

const MAX_SECRET_CHARS = config.get('skills.maxSecretValueChars');
const nameParam = param('name')
    .matches(SECRET_NAME)
    .withMessage('Secret (name) must be 1-100 letters, digits, dots, dashes or underscores.');

module.exports = {
    name: (req) => runValidation(req, [nameParam]),
    put: (req) =>
        runValidation(req, [
            nameParam,
            onlyFields(['value']),
            body('value')
                .isString()
                .isLength({ min: 1, max: MAX_SECRET_CHARS })
                .withMessage(`Value (value) must be a string of 1-${MAX_SECRET_CHARS} characters.`),
        ]),
};
