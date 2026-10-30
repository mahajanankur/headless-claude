'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'ProviderState',
        {
            key: { type: DataTypes.STRING(100), primaryKey: true },
            value: { type: DataTypes.JSONB, allowNull: false },
        },
        { tableName: 'provider_state', createdAt: false },
    );
