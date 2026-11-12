'use strict';

const { SKILL_SOURCE } = require('../../constants/skill');

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'Skill',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID },
            name: { type: DataTypes.STRING(100), allowNull: false },
            source: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: SKILL_SOURCE.BUILTIN,
                validate: { isIn: [Object.values(SKILL_SOURCE)] },
            },
            sourceId: { type: DataTypes.UUID },
            version: { type: DataTypes.STRING(40), allowNull: false },
            manifest: { type: DataTypes.JSONB, allowNull: false },
            checksum: { type: DataTypes.STRING(64), allowNull: false },
            enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            disabledReason: { type: DataTypes.TEXT },
            syncedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        { tableName: 'skills' },
    );
