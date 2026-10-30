'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'AuditLog',
        {
            id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
            appId: { type: DataTypes.UUID },
            actorKeyId: { type: DataTypes.UUID },
            action: { type: DataTypes.STRING(60), allowNull: false },
            targetType: { type: DataTypes.STRING(40) },
            targetId: { type: DataTypes.STRING(100) },
            details: { type: DataTypes.JSONB },
            requestId: { type: DataTypes.STRING(64) },
        },
        { tableName: 'audit_logs', updatedAt: false },
    );
