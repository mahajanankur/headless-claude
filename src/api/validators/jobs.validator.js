'use strict';

const { body, query } = require('express-validator');

const config = require('../../../config');

const { runValidation } = require('../middlewares/validate');
const { onlyFields, uuidParam, SKILL_NAME } = require('./common.validator');
const { JOB_STATUS } = require('../../constants/jobStatus');

const MAX_PAGE = config.get('pagination.maxLimit');
const WAIT_MAX = config.get('job.waitMaxSec');
const MIN_TIMEOUT = config.get('job.minTimeoutSec');
const MAX_TIMEOUT = config.get('job.maxTimeoutSec');
const SUBMIT_FIELDS = [
    'skill',
    'input',
    'model',
    'priority',
    'timeoutSec',
    'runAfter',
    'urgent',
    'sessionId',
    'continueFromJobId',
    'webhookUrl',
];

const submitChains = [
    onlyFields(SUBMIT_FIELDS),
    body('skill').isString().matches(SKILL_NAME).withMessage('Skill (skill) must be a skill name like "repo-review".'),
    body('input').isObject().withMessage('Input (input) must be a JSON object.'),
    body('model')
        .optional()
        .isString()
        .isLength({ min: 1, max: 60 })
        .withMessage('Model (model) must be a model name.'),
    body('priority')
        .optional()
        .isIn(['low', 'normal', 'high'])
        .withMessage('Priority (priority) must be low, normal or high.'),
    body('timeoutSec')
        .optional()
        .isInt({ min: MIN_TIMEOUT, max: MAX_TIMEOUT })
        .withMessage(`Timeout (timeoutSec) must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT}.`)
        .toInt(),
    body('runAfter').optional().isISO8601().withMessage('Run after (runAfter) must be an ISO 8601 time.'),
    body('urgent').optional().isBoolean({ strict: true }).withMessage('Urgent (urgent) must be true or false.'),
    body('sessionId').optional().isUUID().withMessage('Session (sessionId) must be a UUID.'),
    body('continueFromJobId').optional().isUUID().withMessage('Job to continue (continueFromJobId) must be a UUID.'),
    body('webhookUrl')
        .optional()
        .isURL({ require_protocol: true, protocols: ['https', 'http'] })
        .withMessage('Webhook (webhookUrl) must be a URL.'),
    query('wait')
        .optional()
        .isInt({ min: 1, max: WAIT_MAX })
        .withMessage(`Wait (wait) must be between 1 and ${WAIT_MAX} seconds.`)
        .toInt(),
];

const listChains = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: MAX_PAGE })
        .withMessage(`Limit (limit) must be between 1 and ${MAX_PAGE}.`)
        .toInt(),
    query('cursor').optional().isString().isLength({ max: 200 }).withMessage('Cursor (cursor) is not valid.'),
    query('status').optional().isIn(Object.values(JOB_STATUS)).withMessage('Status (status) is not a job status.'),
];

const eventChains = [
    uuidParam('id', 'Job'),
    query('after').optional().isInt({ min: 0 }).withMessage('After (after) must be an event id.').toInt(),
    query('limit')
        .optional()
        .isInt({ min: 1, max: MAX_PAGE })
        .withMessage(`Limit (limit) must be between 1 and ${MAX_PAGE}.`)
        .toInt(),
];

module.exports = {
    submit: (req) => runValidation(req, submitChains),
    list: (req) => runValidation(req, listChains),
    jobId: (req) => runValidation(req, [uuidParam('id', 'Job')]),
    events: (req) => runValidation(req, eventChains),
    artifactId: (req) => runValidation(req, [uuidParam('id', 'Artifact')]),
};
