'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'Session',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID, allowNull: false },
            name: { type: DataTypes.STRING(100) },
            claudeSessionId: { type: DataTypes.UUID },
            workspacePath: { type: DataTypes.TEXT },
            repoUrl: { type: DataTypes.TEXT },
            repoRef: { type: DataTypes.STRING(200) },
            expiresAt: { type: DataTypes.DATE },
            lockedByJobId: { type: DataTypes.UUID },
        },
        { tableName: 'sessions' },
    );
