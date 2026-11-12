'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'SkillSource',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID, allowNull: false },
            repoUrl: { type: DataTypes.TEXT, allowNull: false },
            ref: { type: DataTypes.STRING(200) },
            path: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
            credentialSecret: { type: DataTypes.STRING(100) },
            lastSyncedAt: { type: DataTypes.DATE },
            lastCommit: { type: DataTypes.STRING(64) },
            lastError: { type: DataTypes.TEXT },
        },
        { tableName: 'skill_sources' },
    );
