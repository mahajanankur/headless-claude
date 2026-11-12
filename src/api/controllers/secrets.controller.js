'use strict';

const appSecretService = require('../../services/appSecret.service');
const validator = require('../validators/secrets.validator');
const { Response } = require('../dtos/response.dto');

/** PUT /secrets/:name */
const put = async (req, res, next) => {
    try {
        await validator.put(req);
        const saved = await appSecretService.setSecret(req.context, req.params.name, req.body.value);
        return res.json(new Response(true, 'Secret saved.', saved, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** GET /secrets (names only) */
const list = async (req, res, next) => {
    try {
        const items = await appSecretService.listSecrets(req.context);
        return res.json(new Response(true, 'Secrets.', { items }, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

/** DELETE /secrets/:name */
const remove = async (req, res, next) => {
    try {
        await validator.name(req);
        await appSecretService.deleteSecret(req.context, req.params.name);
        return res.json(new Response(true, 'Secret deleted.', null, req.context.requestId));
    } catch (error) {
        return next(error);
    }
};

module.exports = { put, list, remove };
