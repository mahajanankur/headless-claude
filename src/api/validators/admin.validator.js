'use strict';

const { body } = require('express-validator');

const { runValidation } = require('../middlewares/validate');
const { onlyFields, uuidParam, NAME, SKILL_NAME } = require('./common.validator');
const { SCOPES } = require('../../constants/scopes');

const APP_FIELDS = [
    'allowedSkills',
    'allowedModels',
    'features',
    'runWindows',
    'timezone',
    'dailyTokenBudget',
    'maxConcurrent',
    'webhookAllowedHosts',
    'webhookSecret',
    'streamOrigins',
    'gitCredentialRef',
    'isAdmin',
];

const isValidTimeZone = (tz) => {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

const appChains = (optional) => {
    const field = (name) => (optional ? body(name).optional() : body(name).optional());
    return [
        field('allowedSkills').isArray({ max: 200 }).withMessage('Allowed skills (allowedSkills) must be a list.'),
        body('allowedSkills.*')
            .matches(SKILL_NAME)
            .withMessage('Allowed skills (allowedSkills) must contain skill names.'),
        field('allowedModels')
            .isArray({ min: 1, max: 20 })
            .withMessage('Allowed models (allowedModels) must be a non-empty list.'),
        field('features').isObject().withMessage('Features (features) must be an object of flags.'),
        field('runWindows')
            .custom((v) => v === null || Array.isArray(v))
            .withMessage('Run windows (runWindows) must be a list or null.'),
        field('timezone').custom(isValidTimeZone).withMessage('Time zone (timezone) must be an IANA time zone.'),
        field('dailyTokenBudget')
            .custom((v) => v === null || (Number.isInteger(v) && v > 0))
            .withMessage('Daily token budget (dailyTokenBudget) must be a positive integer or null.'),
        field('maxConcurrent')
            .isInt({ min: 1, max: 50 })
            .withMessage('Max concurrent (maxConcurrent) must be between 1 and 50.')
            .toInt(),
        field('webhookAllowedHosts')
            .isArray({ max: 50 })
            .withMessage('Webhook hosts (webhookAllowedHosts) must be a list.'),
        field('webhookSecret')
            .custom((v) => v === null || (typeof v === 'string' && v.length >= 16))
            .withMessage('Webhook secret (webhookSecret) must be at least 16 characters.'),
        field('streamOrigins').isArray({ max: 50 }).withMessage('Stream origins (streamOrigins) must be a list.'),
        field('gitCredentialRef')
            .custom((v) => v === null || /^[A-Za-z0-9_.-]{1,100}$/.test(v))
            .withMessage('Git credential (gitCredentialRef) must be a secret name.'),
        field('isAdmin').isBoolean({ strict: true }).withMessage('Admin (isAdmin) must be true or false.'),
    ];
};

module.exports = {
    createApp: (req) =>
        runValidation(req, [
            onlyFields(['name', ...APP_FIELDS]),
            body('name')
                .matches(NAME)
                .withMessage('Name (name) must be 1-100 letters, digits, spaces, dots, dashes or underscores.'),
            ...appChains(false),
        ]),
    updateApp: (req) => runValidation(req, [uuidParam('id', 'App'), onlyFields(APP_FIELDS), ...appChains(true)]),
    appId: (req) => runValidation(req, [uuidParam('id', 'App')]),
    createKey: (req) =>
        runValidation(req, [
            uuidParam('id', 'App'),
            onlyFields(['scopes', 'expiresAt']),
            body('scopes').optional().isArray({ min: 1 }).withMessage('Scopes (scopes) must be a non-empty list.'),
            body('scopes.*')
                .isIn(Object.values(SCOPES).filter((s) => s !== SCOPES.ADMIN))
                .withMessage('Scopes (scopes) contains an unknown scope.'),
            body('expiresAt').optional().isISO8601().withMessage('Expiry (expiresAt) must be an ISO 8601 time.'),
        ]),
    keyId: (req) => runValidation(req, [uuidParam('id', 'App'), uuidParam('keyId', 'API key')]),
    jobId: (req) => runValidation(req, [uuidParam('id', 'Job')]),
};
