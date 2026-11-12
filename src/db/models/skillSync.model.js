'use strict';

const { SKILL_SYNC_STATUS } = require('../../constants/skill');

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'SkillSync',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID, allowNull: false },
            sourceId: { type: DataTypes.UUID, allowNull: false },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: SKILL_SYNC_STATUS.QUEUED,
                validate: { isIn: [Object.values(SKILL_SYNC_STATUS)] },
            },
            result: { type: DataTypes.JSONB },
            error: { type: DataTypes.TEXT },
            leaseOwner: { type: DataTypes.STRING(200) },
            startedAt: { type: DataTypes.DATE },
            heartbeatAt: { type: DataTypes.DATE },
            finishedAt: { type: DataTypes.DATE },
        },
        { tableName: 'skill_syncs' },
    );
