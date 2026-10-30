'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'WebhookDelivery',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            jobId: { type: DataTypes.UUID, allowNull: false },
            appId: { type: DataTypes.UUID, allowNull: false },
            status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
            attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            lastError: { type: DataTypes.TEXT },
        },
        { tableName: 'webhook_deliveries' },
    );
