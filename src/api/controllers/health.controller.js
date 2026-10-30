'use strict';

const adminService = require('../../services/admin.service');
const { Response } = require('../dtos/response.dto');

/** GET /health — liveness, no I/O */
const health = (req, res) => res.json(new Response(true, 'ok', { status: 'ok' }, req.context.requestId));

/** GET /ready — database and provider health */
const ready = async (req, res, next) => {
    try {
        const readiness = await adminService.getReadiness();
        return res
            .status(readiness.ready ? 200 : 503)
            .json(
                new Response(
                    readiness.ready,
                    readiness.ready ? 'ready' : 'not ready',
                    readiness,
                    req.context.requestId,
                ),
            );
    } catch (error) {
        return next(error);
    }
};

module.exports = { health, ready };
