'use strict';

const { ATTEMPT_MODE } = require('../../constants/skill');

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'JobAttempt',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            jobId: { type: DataTypes.UUID, allowNull: false },
            appId: { type: DataTypes.UUID, allowNull: false },
            n: { type: DataTypes.INTEGER, allowNull: false },
            skillVersion: { type: DataTypes.STRING(40), allowNull: false },
            skillChecksum: { type: DataTypes.STRING(64), allowNull: false },
            manifest: { type: DataTypes.JSONB, allowNull: false },
            model: { type: DataTypes.STRING(40), allowNull: false },
            mode: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: ATTEMPT_MODE.FRESH,
                validate: { isIn: [Object.values(ATTEMPT_MODE)] },
            },
            runtime: { type: DataTypes.STRING(20), allowNull: false },
            runtimeHandle: { type: DataTypes.JSONB },
            hostId: { type: DataTypes.STRING(200), allowNull: false },
            workspacePath: { type: DataTypes.TEXT },
            streamOffset: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
            streamSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            startedActing: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            actedOutsideWorkspace: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            tokenCount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
            exitCode: { type: DataTypes.INTEGER },
            signal: { type: DataTypes.STRING(20) },
            subtype: { type: DataTypes.STRING(60) },
            terminalReason: { type: DataTypes.STRING(60) },
            numTurns: { type: DataTypes.INTEGER },
            usage: { type: DataTypes.JSONB },
            modelUsage: { type: DataTypes.JSONB },
            claudeSessionId: { type: DataTypes.UUID },
            errorClass: { type: DataTypes.STRING(40) },
            errorMessage: { type: DataTypes.TEXT },
            startedAt: { type: DataTypes.DATE },
            finishedAt: { type: DataTypes.DATE },
        },
        { tableName: 'job_attempts' },
    );
