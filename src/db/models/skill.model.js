'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'Skill',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            name: { type: DataTypes.STRING(100), allowNull: false },
            version: { type: DataTypes.STRING(40), allowNull: false },
            manifest: { type: DataTypes.JSONB, allowNull: false },
            checksum: { type: DataTypes.STRING(64), allowNull: false },
            enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            disabledReason: { type: DataTypes.TEXT },
            syncedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        { tableName: 'skills' },
    );
