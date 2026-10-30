'use strict';

const chatService = require('../../services/chat.service');
const validator = require('../validators/chat.validator');
const { Response } = require('../dtos/response.dto');

/** POST /chat — send a message; returns the reply when it arrives within ?wait (default: the maximum). */
const send = async (req, res, next) => {
    try {
        await validator.send(req);
        const result = await chatService.sendMessage(req.context, req.body, { waitSec: req.query.wait });
        const done = result.status === 'succeeded';
        return res
            .status(done ? 200 : 202)
            .json(
                new Response(true, done ? 'Reply ready.' : `Reply is ${result.status}.`, result, req.context.requestId),
            );
    } catch (error) {
        return next(error);
    }
};

/** GET /chat/:id — conversation history */
const history = async (req, res, next) => {
    try {
        await validator.sessionId(req);
        return res.json(
            new Response(
                true,
                'Chat.',
                await chatService.getHistory(req.context, req.params.id),
                req.context.requestId,
            ),
        );
    } catch (error) {
        return next(error);
    }
};

module.exports = { send, history };
