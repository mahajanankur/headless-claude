'use strict';

const express = require('express');

const jobs = require('../controllers/jobs.controller');
const skills = require('../controllers/skills.controller');
const sessions = require('../controllers/sessions.controller');
const admin = require('../controllers/admin.controller');
const chat = require('../controllers/chat.controller');
const healthController = require('../controllers/health.controller');
const { stream } = require('../controllers/stream.controller');
const { authenticate, requireScope, requireAdmin, requireFeature } = require('../middlewares/authenticate');
const { streamAuth } = require('../middlewares/streamAuth');
const { perKey } = require('../middlewares/rateLimit');
const { SCOPES } = require('../../constants/scopes');
const { FEATURES } = require('../../constants/features');

const router = express.Router();

router.get('/health', healthController.health);
router.get('/ready', healthController.ready);
router.get('/jobs/:id/stream', streamAuth, stream);

router.use(authenticate, perKey);

const read = requireScope(SCOPES.JOBS_READ);
const write = requireScope(SCOPES.JOBS_WRITE);
router.post('/jobs', write, jobs.submit);
router.get('/jobs', read, jobs.list);
router.get('/jobs/:id', read, jobs.get);
router.get('/jobs/:id/result', read, jobs.result);
router.get('/jobs/:id/events', read, jobs.events);
router.get('/jobs/:id/artifacts', read, jobs.artifacts);
router.post('/jobs/:id/cancel', write, jobs.cancel);
router.post('/jobs/:id/retry', write, jobs.retry);
router.post('/jobs/:id/stream-token', read, requireFeature(FEATURES.STREAM_TOKENS), jobs.streamToken);
router.get('/artifacts/:id', read, jobs.download);

router.get('/skills', requireScope(SCOPES.SKILLS_READ), skills.list);
router.get('/skills/:name', requireScope(SCOPES.SKILLS_READ), skills.get);

const chatOn = requireFeature(FEATURES.CHAT);
router.post('/chat', write, chatOn, chat.send);
router.get('/chat/:id', read, chatOn, chat.history);

const sessionsOn = requireFeature(FEATURES.SESSIONS);
router.post('/sessions', requireScope(SCOPES.SESSIONS_WRITE), sessionsOn, sessions.create);
router.get('/sessions/:id', read, sessionsOn, sessions.get);
router.delete('/sessions/:id', requireScope(SCOPES.SESSIONS_WRITE), sessionsOn, sessions.remove);

const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/apps', admin.listApps);
adminRouter.post('/apps', admin.createApp);
adminRouter.get('/apps/:id', admin.getApp);
adminRouter.patch('/apps/:id', admin.updateApp);
adminRouter.get('/apps/:id/keys', admin.listKeys);
adminRouter.post('/apps/:id/keys', admin.createKey);
adminRouter.delete('/apps/:id/keys/:keyId', admin.revokeKey);
adminRouter.post('/apps/:id/pause', admin.pauseApp);
adminRouter.post('/apps/:id/resume', admin.resumeApp);
adminRouter.post('/apps/:id/kill', admin.killApp);
adminRouter.post('/intake/pause', admin.pauseIntake);
adminRouter.post('/intake/resume', admin.resumeIntake);
adminRouter.get('/stats', admin.stats);
adminRouter.post('/jobs/:id/redeliver', admin.redeliver);
router.use('/admin', adminRouter);

module.exports = router;
