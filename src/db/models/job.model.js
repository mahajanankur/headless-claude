'use strict';

const { JOB_STATUS } = require('../../constants/jobStatus');
const { SKILL_CLASS, ATTEMPT_MODE } = require('../../constants/skill');

module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'Job',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            appId: { type: DataTypes.UUID, allowNull: false },
            apiKeyId: { type: DataTypes.UUID },
            skillName: { type: DataTypes.STRING(100), allowNull: false },
            skillClass: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: SKILL_CLASS.QUICK,
                validate: { isIn: [Object.values(SKILL_CLASS)] },
            },
            model: { type: DataTypes.STRING(40), allowNull: false },
            input: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            inputHash: { type: DataTypes.STRING(64), allowNull: false },
            status: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: JOB_STATUS.QUEUED,
                validate: { isIn: [Object.values(JOB_STATUS)] },
            },
            priority: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
            urgent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            runAfter: { type: DataTypes.DATE },
            idempotencyKey: { type: DataTypes.STRING(200) },
            sessionId: { type: DataTypes.UUID },
            continueFromJobId: { type: DataTypes.UUID },
            timeoutSec: { type: DataTypes.INTEGER },
            webhookUrl: { type: DataTypes.TEXT },
            repoUrl: { type: DataTypes.TEXT },
            repoRef: { type: DataTypes.STRING(200) },
            leaseOwner: { type: DataTypes.STRING(200) },
            leaseExpiresAt: { type: DataTypes.DATE },
            cancelRequested: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            autoRetries: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            statusSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            nextAttemptMode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: ATTEMPT_MODE.FRESH },
            resumeAttemptId: { type: DataTypes.UUID },
            result: { type: DataTypes.JSONB },
            errorCode: { type: DataTypes.STRING(60) },
            errorMessage: { type: DataTypes.TEXT },
            possiblyPartial: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            deliveryStatus: { type: DataTypes.STRING(20) },
            deliveryError: { type: DataTypes.TEXT },
            branch: { type: DataTypes.STRING(200) },
            prUrl: { type: DataTypes.TEXT },
            startedAt: { type: DataTypes.DATE },
            finishedAt: { type: DataTypes.DATE },
        },
        { tableName: 'jobs' },
    );
