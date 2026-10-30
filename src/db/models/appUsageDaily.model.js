'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'AppUsageDaily',
        {
            appId: { type: DataTypes.UUID, primaryKey: true },
            day: { type: DataTypes.DATEONLY, primaryKey: true },
            tokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        },
        { tableName: 'app_usage_daily', timestamps: false },
    );
