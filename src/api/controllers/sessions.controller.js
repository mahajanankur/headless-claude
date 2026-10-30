'use strict';

const sessionService = require('../../services/session.service');
const validator = require('../validators/sessions.validator');
const { Response } = require('../dtos/response.dto');

/** POST /sessions */
const create = async (req, res, next) => {
    try {
        await validator.create(req);
        const session = await sessionService.createSession(req.context, req.body);
        return res.status(201).json(new Response(true, 'Session created.', session, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /sessions/:id */
const get = async (req, res, next) => {
    try {
        await validator.sessionId(req);
        return res.json(
            new Response(
                true,
                'Session.',
                await sessionService.getSession(req.context, req.params.id),
                req.context.requestId,
            ),
        );
    } catch (error) {
        return next(error);
    }
};

/** DELETE /sessions/:id */
const remove = async (req, res, next) => {
    try {
        await validator.sessionId(req);
        await sessionService.deleteSession(req.context, req.params.id);
        return res.json(new Response(true, 'Session deleted.', null, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

module.exports = { create, get, remove };
