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

/** POST /skills (raw application/gzip body: the skill package) */
const upload = async (req, res, next) => {
    try {
        const saved = await skillService.addVersion({
            appId: req.context.appId,
            buffer: Buffer.isBuffer(req.body) ? req.body : null,
            keyId: req.context.keyId,
        });
        const created = saved.status === skillService.VERSION_STATUS.CREATED;
        return res
            .status(created ? 201 : 200)
            .json(
                new Response(
                    true,
                    created ? 'Skill version added.' : 'Skill version unchanged.',
                    saved,
                    req.context.requestId,
                ),
            );
    } catch (error) {
        return next(error);
    }
};

/** PATCH /skills/:name */
const update = async (req, res, next) => {
    try {
        await validator.update(req);
        const skill = await skillService.setSkillEnabled(req.context.appId, req.params.name, req.body.enabled);
        return res.json(new Response(true, 'Skill updated.', skill, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** PATCH /skills/:name/versions/:version */
const updateVersion = async (req, res, next) => {
    try {
        await validator.updateVersion(req);
        const { name, version } = req.params;
        const skill = await skillService.setVersionEnabled(req.context.appId, name, version, req.body.enabled);
        return res.json(new Response(true, 'Skill version updated.', skill, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** DELETE /skills/:name */
const remove = async (req, res, next) => {
    try {
        await validator.name(req);
        await skillService.deleteSkill(req.context.appId, req.params.name);
        return res.json(new Response(true, 'Skill deleted.', null, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

module.exports = { list, get, upload, update, updateVersion, remove };
