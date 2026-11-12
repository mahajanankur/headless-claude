'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'SkillVersion',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            skillId: { type: DataTypes.UUID, allowNull: false },
            version: { type: DataTypes.STRING(40), allowNull: false },
            checksum: { type: DataTypes.STRING(64), allowNull: false },
            manifest: { type: DataTypes.JSONB, allowNull: false },
            package: { type: DataTypes.BLOB, allowNull: false },
            sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
            enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            createdByKeyId: { type: DataTypes.UUID },
        },
        { tableName: 'skill_versions' },
    );
