'use strict';

/** Initial schema for headless-claude (spec §5, rules §8). */
module.exports = {
    up: async (queryInterface, Sequelize) => {
        const { DataTypes } = Sequelize;
        const now = Sequelize.literal('now()');
        const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') };
        const timestamps = {
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        };
        const fk = (table, { onDelete = 'CASCADE', allowNull = false } = {}) => ({
            type: DataTypes.UUID,
            allowNull,
            references: { model: table, key: 'id' },
            onDelete,
        });
        const strings = (defaultValue = []) => ({
            type: DataTypes.ARRAY(DataTypes.STRING),
            allowNull: false,
            defaultValue,
        });

        await queryInterface.sequelize.transaction(async (transaction) => {
            const opts = { transaction };

            await queryInterface.createTable(
                'apps',
                {
                    id,
                    name: { type: DataTypes.STRING(100), allowNull: false },
                    allowed_skills: strings(),
                    allowed_models: strings(['haiku', 'sonnet']),
                    features: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
                    run_windows: { type: DataTypes.JSONB, allowNull: true },
                    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'UTC' },
                    daily_token_budget: { type: DataTypes.BIGINT, allowNull: true },
                    max_concurrent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
                    intake_paused: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    webhook_secret_enc: { type: DataTypes.TEXT, allowNull: true },
                    webhook_allowed_hosts: strings(),
                    stream_origins: strings(),
                    git_credential_ref: { type: DataTypes.STRING(100), allowNull: true },
                    is_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('apps', ['name'], { name: 'apps_name_uq', unique: true, ...opts });

            await queryInterface.createTable(
                'api_keys',
                {
                    id,
                    app_id: fk('apps'),
                    key_hash: { type: DataTypes.STRING(64), allowNull: false },
                    display_prefix: { type: DataTypes.STRING(20), allowNull: false },
                    last4: { type: DataTypes.STRING(4), allowNull: false },
                    scopes: strings(),
                    expires_at: { type: DataTypes.DATE, allowNull: true },
                    revoked_at: { type: DataTypes.DATE, allowNull: true },
                    last_used_at: { type: DataTypes.DATE, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('api_keys', ['key_hash'], {
                name: 'api_keys_key_hash_uq',
                unique: true,
                ...opts,
            });
            await queryInterface.addIndex('api_keys', ['app_id', 'created_at', 'id'], {
                name: 'api_keys_app_created_idx',
                ...opts,
            });

            await queryInterface.createTable(
                'skills',
                {
                    id,
                    name: { type: DataTypes.STRING(100), allowNull: false },
                    version: { type: DataTypes.STRING(40), allowNull: false },
                    manifest: { type: DataTypes.JSONB, allowNull: false },
                    checksum: { type: DataTypes.STRING(64), allowNull: false },
                    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
                    disabled_reason: { type: DataTypes.TEXT, allowNull: true },
                    synced_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('skills', ['name'], { name: 'skills_name_uq', unique: true, ...opts });

            await queryInterface.createTable(
                'sessions',
                {
                    id,
                    app_id: fk('apps'),
                    name: { type: DataTypes.STRING(100), allowNull: true },
                    claude_session_id: { type: DataTypes.UUID, allowNull: true },
                    workspace_path: { type: DataTypes.TEXT, allowNull: true },
                    repo_url: { type: DataTypes.TEXT, allowNull: true },
                    repo_ref: { type: DataTypes.STRING(200), allowNull: true },
                    expires_at: { type: DataTypes.DATE, allowNull: true },
                    locked_by_job_id: { type: DataTypes.UUID, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('sessions', ['app_id', 'name'], {
                name: 'sessions_app_name_uq',
                unique: true,
                where: { name: { [Sequelize.Op.ne]: null } },
                ...opts,
            });

            await queryInterface.createTable(
                'jobs',
                {
                    id,
                    app_id: fk('apps'),
                    api_key_id: fk('api_keys', { onDelete: 'SET NULL', allowNull: true }),
                    skill_name: { type: DataTypes.STRING(100), allowNull: false },
                    skill_class: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'quick' },
                    model: { type: DataTypes.STRING(40), allowNull: false },
                    input: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
                    input_hash: { type: DataTypes.STRING(64), allowNull: false },
                    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
                    priority: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
                    urgent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    run_after: { type: DataTypes.DATE, allowNull: true },
                    idempotency_key: { type: DataTypes.STRING(200), allowNull: true },
                    session_id: fk('sessions', { onDelete: 'SET NULL', allowNull: true }),
                    continue_from_job_id: { type: DataTypes.UUID, allowNull: true },
                    timeout_sec: { type: DataTypes.INTEGER, allowNull: true },
                    webhook_url: { type: DataTypes.TEXT, allowNull: true },
                    repo_url: { type: DataTypes.TEXT, allowNull: true },
                    repo_ref: { type: DataTypes.STRING(200), allowNull: true },
                    lease_owner: { type: DataTypes.STRING(200), allowNull: true },
                    lease_expires_at: { type: DataTypes.DATE, allowNull: true },
                    cancel_requested: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                    auto_retries: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                    status_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                    next_attempt_mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'fresh' },
                    resume_attempt_id: { type: DataTypes.UUID, allowNull: true },
                    result: { type: DataTypes.JSONB, allowNull: true },
                    error_code: { type: DataTypes.STRING(60), allowNull: true },
                    error_message: { type: DataTypes.TEXT, allowNull: true },
                    possibly_partial: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    delivery_status: { type: DataTypes.STRING(20), allowNull: true },
                    delivery_error: { type: DataTypes.TEXT, allowNull: true },
                    branch: { type: DataTypes.STRING(200), allowNull: true },
                    pr_url: { type: DataTypes.TEXT, allowNull: true },
                    started_at: { type: DataTypes.DATE, allowNull: true },
                    finished_at: { type: DataTypes.DATE, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('jobs', ['app_id', 'idempotency_key'], {
                name: 'jobs_app_idempotency_uq',
                unique: true,
                where: { idempotency_key: { [Sequelize.Op.ne]: null } },
                ...opts,
            });
            await queryInterface.addIndex('jobs', ['app_id', 'created_at', 'id'], {
                name: 'jobs_app_created_idx',
                ...opts,
            });
            // raw because: per-column DESC ordering to match the claim query's ORDER BY
            await queryInterface.sequelize.query(
                `CREATE INDEX jobs_claim_idx ON jobs (priority DESC, created_at, id) WHERE status = 'queued'`,
                opts,
            );
            await queryInterface.addIndex('jobs', ['lease_expires_at'], {
                name: 'jobs_active_lease_idx',
                where: { status: ['claimed', 'provisioning', 'running', 'cancelling'] },
                ...opts,
            });

            await queryInterface.createTable(
                'job_attempts',
                {
                    id,
                    job_id: fk('jobs'),
                    app_id: fk('apps'),
                    n: { type: DataTypes.INTEGER, allowNull: false },
                    skill_version: { type: DataTypes.STRING(40), allowNull: false },
                    skill_checksum: { type: DataTypes.STRING(64), allowNull: false },
                    manifest: { type: DataTypes.JSONB, allowNull: false },
                    model: { type: DataTypes.STRING(40), allowNull: false },
                    mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'fresh' },
                    runtime: { type: DataTypes.STRING(20), allowNull: false },
                    runtime_handle: { type: DataTypes.JSONB, allowNull: true },
                    host_id: { type: DataTypes.STRING(200), allowNull: false },
                    workspace_path: { type: DataTypes.TEXT, allowNull: true },
                    stream_offset: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
                    stream_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                    started_acting: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    acted_outside_workspace: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                    token_count: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
                    exit_code: { type: DataTypes.INTEGER, allowNull: true },
                    signal: { type: DataTypes.STRING(20), allowNull: true },
                    subtype: { type: DataTypes.STRING(60), allowNull: true },
                    terminal_reason: { type: DataTypes.STRING(60), allowNull: true },
                    num_turns: { type: DataTypes.INTEGER, allowNull: true },
                    usage: { type: DataTypes.JSONB, allowNull: true },
                    model_usage: { type: DataTypes.JSONB, allowNull: true },
                    claude_session_id: { type: DataTypes.UUID, allowNull: true },
                    error_class: { type: DataTypes.STRING(40), allowNull: true },
                    error_message: { type: DataTypes.TEXT, allowNull: true },
                    started_at: { type: DataTypes.DATE, allowNull: true },
                    finished_at: { type: DataTypes.DATE, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('job_attempts', ['job_id', 'n'], {
                name: 'job_attempts_job_n_uq',
                unique: true,
                ...opts,
            });

            await queryInterface.createTable(
                'job_events',
                {
                    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
                    job_id: fk('jobs'),
                    app_id: fk('apps'),
                    attempt_id: fk('job_attempts', { allowNull: true }),
                    seq: { type: DataTypes.INTEGER, allowNull: false },
                    ts: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
                    type: { type: DataTypes.STRING(30), allowNull: false },
                    summary: { type: DataTypes.TEXT, allowNull: true },
                },
                opts,
            );
            // raw because: NULLS NOT DISTINCT (PG 15+) so job-level events (attempt_id NULL) deduplicate too
            await queryInterface.sequelize.query(
                'CREATE UNIQUE INDEX job_events_job_attempt_seq_uq ON job_events (job_id, attempt_id, seq) NULLS NOT DISTINCT',
                opts,
            );
            await queryInterface.addIndex('job_events', ['app_id', 'job_id', 'id'], {
                name: 'job_events_app_job_idx',
                ...opts,
            });

            await queryInterface.createTable(
                'artifacts',
                {
                    id,
                    job_id: fk('jobs'),
                    app_id: fk('apps'),
                    name: { type: DataTypes.STRING(255), allowNull: false },
                    path: { type: DataTypes.TEXT, allowNull: false },
                    size: { type: DataTypes.BIGINT, allowNull: false },
                    mime: { type: DataTypes.STRING(100), allowNull: true },
                    sha256: { type: DataTypes.STRING(64), allowNull: false },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('artifacts', ['app_id', 'job_id', 'id'], {
                name: 'artifacts_app_job_idx',
                ...opts,
            });

            await queryInterface.createTable(
                'webhook_deliveries',
                {
                    id,
                    job_id: fk('jobs'),
                    app_id: fk('apps'),
                    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
                    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                    next_attempt_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
                    last_error: { type: DataTypes.TEXT, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('webhook_deliveries', ['status', 'next_attempt_at'], {
                name: 'webhook_deliveries_due_idx',
                ...opts,
            });

            await queryInterface.createTable(
                'provider_state',
                {
                    key: { type: DataTypes.STRING(100), primaryKey: true },
                    value: { type: DataTypes.JSONB, allowNull: false },
                    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
                },
                opts,
            );

            await queryInterface.createTable(
                'app_usage_daily',
                {
                    app_id: { ...fk('apps'), primaryKey: true },
                    day: { type: DataTypes.DATEONLY, primaryKey: true },
                    tokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
                },
                opts,
            );

            await queryInterface.createTable(
                'audit_logs',
                {
                    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
                    app_id: fk('apps', { onDelete: 'SET NULL', allowNull: true }),
                    actor_key_id: { type: DataTypes.UUID, allowNull: true },
                    action: { type: DataTypes.STRING(60), allowNull: false },
                    target_type: { type: DataTypes.STRING(40), allowNull: true },
                    target_id: { type: DataTypes.STRING(100), allowNull: true },
                    details: { type: DataTypes.JSONB, allowNull: true },
                    request_id: { type: DataTypes.STRING(64), allowNull: true },
                    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
                },
                opts,
            );
            await queryInterface.addIndex('audit_logs', ['app_id', 'created_at', 'id'], {
                name: 'audit_logs_app_created_idx',
                ...opts,
            });
        });
    },

    down: async (queryInterface) => {
        await queryInterface.sequelize.transaction(async (transaction) => {
            const tables = [
                'audit_logs',
                'app_usage_daily',
                'provider_state',
                'webhook_deliveries',
                'artifacts',
                'job_events',
                'job_attempts',
                'jobs',
                'sessions',
                'skills',
                'api_keys',
                'apps',
            ];
            for (const table of tables) {
                await queryInterface.dropTable(table, { transaction });
            }
        });
    },
};
