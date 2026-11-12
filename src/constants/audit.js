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
    SKILL_VERSION_ADDED: 'skill.version_added',
    SKILL_UPDATED: 'skill.updated',
    SKILL_DELETED: 'skill.deleted',
    SKILLS_RESYNCED: 'skills.resynced',
    SKILL_SOURCE_CREATED: 'skill_source.created',
    SKILL_SOURCE_DELETED: 'skill_source.deleted',
    SKILL_SYNC_REQUESTED: 'skill_source.sync_requested',
    SECRET_SET: 'secret.set',
    SECRET_DELETED: 'secret.deleted',
});

module.exports = { AUDIT_ACTION };
