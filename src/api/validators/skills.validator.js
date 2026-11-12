'use strict';

const { body, param } = require('express-validator');

const { runValidation } = require('../middlewares/validate');
const { onlyFields, SKILL_NAME, SKILL_VERSION } = require('./common.validator');

const nameParam = param('name').matches(SKILL_NAME).withMessage('Skill (name) must be a skill name.');
const enabledBody = [
    onlyFields(['enabled']),
    body('enabled').isBoolean({ strict: true }).withMessage('Enabled (enabled) must be true or false.'),
];

module.exports = {
    name: (req) => runValidation(req, [nameParam]),
    update: (req) => runValidation(req, [nameParam, ...enabledBody]),
    updateVersion: (req) =>
        runValidation(req, [
            nameParam,
            param('version').matches(SKILL_VERSION).withMessage('Version (version) must be like 1.2.0.'),
            ...enabledBody,
        ]),
};
