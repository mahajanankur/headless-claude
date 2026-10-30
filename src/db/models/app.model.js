'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'App',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            name: { type: DataTypes.STRING(100), allowNull: false },
            allowedSkills: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
            allowedModels: {
                type: DataTypes.ARRAY(DataTypes.STRING),
                allowNull: false,
                defaultValue: ['haiku', 'sonnet'],
            },
            features: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            runWindows: { type: DataTypes.JSONB },
            timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'UTC' },
            dailyTokenBudget: { type: DataTypes.BIGINT },
            maxConcurrent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
            intakePaused: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            webhookSecretEnc: { type: DataTypes.TEXT },
            webhookAllowedHosts: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
            streamOrigins: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
            gitCredentialRef: { type: DataTypes.STRING(100) },
            isAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        },
        { tableName: 'apps' },
    );
