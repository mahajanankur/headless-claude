'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'AppSecret',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID, allowNull: false },
            name: { type: DataTypes.STRING(100), allowNull: false },
            valueEncrypted: { type: DataTypes.TEXT, allowNull: false },
        },
        { tableName: 'app_secrets' },
    );
