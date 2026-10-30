'use strict';

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'JobEvent',
        {
            id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
            jobId: { type: DataTypes.UUID, allowNull: false },
            appId: { type: DataTypes.UUID, allowNull: false },
            attemptId: { type: DataTypes.UUID },
            seq: { type: DataTypes.INTEGER, allowNull: false },
            ts: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            type: { type: DataTypes.STRING(30), allowNull: false },
            summary: { type: DataTypes.TEXT },
        },
        { tableName: 'job_events', timestamps: false },
    );
