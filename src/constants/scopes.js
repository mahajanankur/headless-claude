'use strict';

/** API key scopes. Never use scope string literals elsewhere. */
const SCOPES = Object.freeze({
    JOBS_READ: 'jobs:read',
    JOBS_WRITE: 'jobs:write',
    SKILLS_READ: 'skills:read',
    SKILLS_WRITE: 'skills:write',
    SECRETS_WRITE: 'secrets:write',
    SESSIONS_WRITE: 'sessions:write',
    ADMIN: 'admin',
});

const DEFAULT_KEY_SCOPES = Object.freeze([
    SCOPES.JOBS_READ,
    SCOPES.JOBS_WRITE,
    SCOPES.SKILLS_READ,
    SCOPES.SESSIONS_WRITE,
    // only usable when the app's skillsManageActive flag is on
    SCOPES.SKILLS_WRITE,
    SCOPES.SECRETS_WRITE,
]);

module.exports = { SCOPES, DEFAULT_KEY_SCOPES };
