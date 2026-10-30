'use strict';

const skillService = require('../../services/skill.service');
const validator = require('../validators/skills.validator');
const { Response } = require('../dtos/response.dto');

/** GET /skills */
const list = async (req, res, next) => {
    try {
        const items = await skillService.listSkillsForApp(req.context.app);
        return res.json(new Response(true, 'Skills.', { items }, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /skills/:name */
const get = async (req, res, next) => {
    try {
        await validator.name(req);
        const skill = await skillService.getSkillForApp(req.context.app, req.params.name);
        return res.json(new Response(true, 'Skill.', skill, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

module.exports = { list, get };
