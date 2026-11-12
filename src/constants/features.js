'use strict';

/** Per-app feature flags stored in apps.features. Absent = OFF. */
const FEATURES = Object.freeze({
    SESSIONS: 'sessionsActive',
    CHANGE_DELIVERY: 'changeDeliveryActive',
    WEBHOOKS: 'webhooksActive',
    STREAM_TOKENS: 'streamTokensActive',
    WAIT_MODE: 'waitModeActive',
    CHAT: 'chatActive',
    SKILLS_MANAGE: 'skillsManageActive',
    /** The app's own skills may grant Bash and MCP servers (admin only: such code can read the Claude credential). */
    SKILLS_SHELL: 'skillsShellActive',
});

module.exports = { FEATURES };
