'use strict';

/** audit_logs.action values. */
const AUDIT_ACTION = Object.freeze({
    APP_CREATED: 'app.created',
    APP_UPDATED: 'app.updated',
    KEY_CREATED: 'key.created',
    KEY_REVOKED: 'key.revoked',
    FEATURE_SET: 'feature.set',
    JOB_CANCELLED: 'job.cancelled',
    JOB_RETRIED: 'job.retried',
    JOB_REDELIVERED: 'job.redelivered',
    INTAKE_PAUSED: 'intake.paused',
    INTAKE_RESUMED: 'intake.resumed',
    APP_JOBS_CANCELLED: 'app.jobs_cancelled',
});

module.exports = { AUDIT_ACTION };
