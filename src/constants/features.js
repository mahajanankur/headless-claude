'use strict';

/** Per-app feature flags stored in apps.features. Absent = OFF. */
const FEATURES = Object.freeze({
    SESSIONS: 'sessionsActive',
    CHANGE_DELIVERY: 'changeDeliveryActive',
    WEBHOOKS: 'webhooksActive',
    STREAM_TOKENS: 'streamTokensActive',
    WAIT_MODE: 'waitModeActive',
    CHAT: 'chatActive',
});

module.exports = { FEATURES };
