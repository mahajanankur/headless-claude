'use strict';

const { Sequelize, DataTypes } = require('sequelize');

const config = require('../../../config');
const getLogger = require('../../utils/logger');

const logger = getLogger(__filename);

const databaseUrl = config.get('postgres.url');
if (!databaseUrl) {
    throw new Error('postgres.url is not set. Set DATABASE_URL (see .env.example).');
}

const sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: config.get('postgres.logging') ? (sql) => logger.debug(sql) : false,
    define: { underscored: true, timestamps: true },
    pool: { max: config.get('postgres.poolMax'), min: 0, idle: 10000 },
    dialectOptions: { statement_timeout: config.get('postgres.statementTimeoutMs') },
});

const models = {
    App: require('./app.model')(sequelize, DataTypes),
    ApiKey: require('./apiKey.model')(sequelize, DataTypes),
    Skill: require('./skill.model')(sequelize, DataTypes),
    Session: require('./session.model')(sequelize, DataTypes),
    Job: require('./job.model')(sequelize, DataTypes),
    JobAttempt: require('./jobAttempt.model')(sequelize, DataTypes),
    JobEvent: require('./jobEvent.model')(sequelize, DataTypes),
    Artifact: require('./artifact.model')(sequelize, DataTypes),
    WebhookDelivery: require('./webhookDelivery.model')(sequelize, DataTypes),
    ProviderState: require('./providerState.model')(sequelize, DataTypes),
    AppUsageDaily: require('./appUsageDaily.model')(sequelize, DataTypes),
    AuditLog: require('./auditLog.model')(sequelize, DataTypes),
};

const { App, ApiKey, Session, Job, JobAttempt, JobEvent, Artifact, WebhookDelivery } = models;

App.hasMany(ApiKey, { foreignKey: 'appId', as: 'apiKeys' });
ApiKey.belongsTo(App, { foreignKey: 'appId', as: 'app' });
App.hasMany(Job, { foreignKey: 'appId', as: 'jobs' });
Job.belongsTo(App, { foreignKey: 'appId', as: 'app' });
Session.belongsTo(App, { foreignKey: 'appId', as: 'app' });
Job.belongsTo(Session, { foreignKey: 'sessionId', as: 'session' });
Job.hasMany(JobAttempt, { foreignKey: 'jobId', as: 'attempts' });
JobAttempt.belongsTo(Job, { foreignKey: 'jobId', as: 'job' });
Job.hasMany(JobEvent, { foreignKey: 'jobId', as: 'events' });
Job.hasMany(Artifact, { foreignKey: 'jobId', as: 'artifacts' });
Artifact.belongsTo(Job, { foreignKey: 'jobId', as: 'job' });
Job.hasMany(WebhookDelivery, { foreignKey: 'jobId', as: 'webhookDeliveries' });

module.exports = { sequelize, Sequelize, ...models };
