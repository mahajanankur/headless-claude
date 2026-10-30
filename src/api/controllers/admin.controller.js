'use strict';

const appService = require('../../services/app.service');
const adminService = require('../../services/admin.service');
const deliveryService = require('../../services/delivery.service');
const validator = require('../validators/admin.validator');
const { Response } = require('../dtos/response.dto');

const handle =
    (validate, work, { status = 200, message }) =>
    async (req, res, next) => {
        try {
            if (validate) await validate(req);
            const data = await work(req);
            return res.status(status).json(new Response(true, message, data, req.context.requestId));
        } catch (error) {
            return next(error);
        }
    };

module.exports = {
    listApps: handle(null, async () => ({ items: await appService.listApps() }), { message: 'Apps.' }),
    createApp: handle(
        validator.createApp,
        async (req) => {
            const { name, ...rest } = req.body;
            const { webhookSecret, ...fields } = rest;
            const created = await appService.createApp({ name, ...fields });
            if (webhookSecret) created.app = await appService.updateApp(created.app.id, { webhookSecret });
            return created;
        },
        { status: 201, message: 'App created. Store the API key now; it is not shown again.' },
    ),
    getApp: handle(validator.appId, (req) => appService.getApp(req.params.id), { message: 'App.' }),
    updateApp: handle(validator.updateApp, (req) => appService.updateApp(req.params.id, req.body), {
        message: 'App updated.',
    }),
    listKeys: handle(validator.appId, async (req) => ({ items: await appService.listApiKeys(req.params.id) }), {
        message: 'API keys.',
    }),
    createKey: handle(
        validator.createKey,
        (req) =>
            appService.createApiKey(req.params.id, {
                scopes: req.body.scopes,
                expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
            }),
        { status: 201, message: 'API key created. Store it now; it is not shown again.' },
    ),
    revokeKey: handle(validator.keyId, (req) => appService.revokeApiKey(req.params.id, req.params.keyId), {
        message: 'API key revoked.',
    }),
    pauseApp: handle(validator.appId, (req) => adminService.setAppIntake(req.params.id, true), {
        message: 'Intake paused.',
    }),
    resumeApp: handle(validator.appId, (req) => adminService.setAppIntake(req.params.id, false), {
        message: 'Intake resumed.',
    }),
    killApp: handle(validator.appId, (req) => adminService.killApp(req.params.id, req.context), {
        message: 'Intake paused and jobs cancelled.',
    }),
    pauseIntake: handle(null, () => adminService.setGlobalIntake(true), { message: 'Global intake paused.' }),
    resumeIntake: handle(null, () => adminService.setGlobalIntake(false), { message: 'Global intake resumed.' }),
    stats: handle(null, () => adminService.getStats(), { message: 'Stats.' }),
    redeliver: handle(validator.jobId, (req) => deliveryService.requestRedelivery(req.params.id), {
        status: 202,
        message: 'Redelivery queued.',
    }),
};
