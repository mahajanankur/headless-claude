'use strict';

const { param } = require('express-validator');

const { runValidation } = require('../middlewares/validate');
const { SKILL_NAME } = require('./common.validator');

module.exports = {
    name: (req) =>
        runValidation(req, [param('name').matches(SKILL_NAME).withMessage('Skill (name) must be a skill name.')]),
};
