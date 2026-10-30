'use strict';

const { AuditLog } = require('../db/models');

const { withErrorLogging } = require('./base.repository');

module.exports = withErrorLogging('auditLog.repository', {
    /**
     * @param {{appId?: string, actorKeyId?: string, action: string, targetType?: string, targetId?: string, details?: Object, requestId?: string}} entry
     * @param {{transaction?: Object}} [options]
     * @returns {Promise<void>}
     */
    create: async (entry, { transaction } = {}) => {
        await AuditLog.create(entry, { transaction });
    },
});
