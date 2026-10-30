'use strict';

const auditLogRepository = require('../repositories/auditLog.repository');
const { getContext } = require('../utils/requestContext');

/**
 * Record an audited action (keys, flags, cancel, kill-switch, admin). Request context is attached.
 * @param {{appId?: string, action: string, targetType?: string, targetId?: string, details?: Object}} entry
 * @param {{transaction?: Object, actorKeyId?: string}} [options]
 * @returns {Promise<void>}
 */
const recordAudit = async (entry, { transaction, actorKeyId } = {}) => {
    const { requestId, keyId } = getContext();
    await auditLogRepository.create(
        { ...entry, actorKeyId: actorKeyId || keyId || null, requestId: requestId || null },
        { transaction },
    );
};

module.exports = { recordAudit };
