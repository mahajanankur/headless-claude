'use strict';

const skillSourceService = require('../../services/skillSource.service');
const validator = require('../validators/skillSources.validator');
const { Response } = require('../dtos/response.dto');

/** POST /skill-sources */
const create = async (req, res, next) => {
    try {
        await validator.create(req);
        const source = await skillSourceService.createSource(req.context, req.body);
        return res.status(201).json(new Response(true, 'Skill source created.', source, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /skill-sources */
const list = async (req, res, next) => {
    try {
        const items = await skillSourceService.listSources(req.context);
        return res.json(new Response(true, 'Skill sources.', { items }, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** DELETE /skill-sources/:id */
const remove = async (req, res, next) => {
    try {
        await validator.sourceId(req);
        await skillSourceService.deleteSource(req.context, req.params.id);
        return res.json(new Response(true, 'Skill source deleted.', null, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** POST /skill-sources/:id/sync[?wait=] */
const sync = async (req, res, next) => {
    try {
        await validator.sync(req);
        const { sync: result, finished } = await skillSourceService.requestSync(req.context, req.params.id, {
            waitSec: req.query.wait || 0,
        });
        return res
            .status(finished ? 200 : 202)
            .json(new Response(true, finished ? 'Sync finished.' : 'Sync queued.', result, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /skill-sources/:id/syncs/:syncId */
const getSync = async (req, res, next) => {
    try {
        await validator.syncId(req);
        const result = await skillSourceService.getSync(req.context, req.params.id, req.params.syncId);
        return res.json(new Response(true, 'Sync.', result, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

module.exports = { create, list, remove, sync, getSync };
