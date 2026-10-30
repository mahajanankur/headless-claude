'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'ApiKey',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID, allowNull: false },
            keyHash: { type: DataTypes.STRING(64), allowNull: false },
            displayPrefix: { type: DataTypes.STRING(20), allowNull: false },
            last4: { type: DataTypes.STRING(4), allowNull: false },
            scopes: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
            expiresAt: { type: DataTypes.DATE },
            revokedAt: { type: DataTypes.DATE },
            lastUsedAt: { type: DataTypes.DATE },
        },
        { tableName: 'api_keys' },
    );
