'use strict';

/** jobs.delivery_status: outcome of delivering code changes after success. */
const DELIVERY_STATUS = Object.freeze({
    PENDING: 'pending',
    NOT_APPLICABLE: 'not_applicable',
    NO_CHANGES: 'no_changes',
    DELIVERED: 'delivered',
    FAILED: 'failed',
});

/** webhook_deliveries.status */
const WEBHOOK_STATUS = Object.freeze({ PENDING: 'pending', DELIVERED: 'delivered', FAILED: 'failed' });

module.exports = { DELIVERY_STATUS, WEBHOOK_STATUS };
