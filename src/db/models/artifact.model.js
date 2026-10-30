'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'Artifact',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            jobId: { type: DataTypes.UUID, allowNull: false },
            appId: { type: DataTypes.UUID, allowNull: false },
            name: { type: DataTypes.STRING(255), allowNull: false },
            path: { type: DataTypes.TEXT, allowNull: false },
            size: { type: DataTypes.BIGINT, allowNull: false },
            mime: { type: DataTypes.STRING(100) },
            sha256: { type: DataTypes.STRING(64), allowNull: false },
        },
        { tableName: 'artifacts' },
    );
