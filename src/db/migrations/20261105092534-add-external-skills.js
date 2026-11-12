'use strict';

const BACKFILL_BATCH = 5000;

/**
 * External skills (spec docs/superpowers/specs/04-11-2026-external-skills-design.md §5):
 * app-owned skills, immutable versions with their package, git sources and syncs, per-app secrets,
 * and the skill a job runs. Expand-only: running code keeps working (skills.name stays unique for
 * gateway skills, jobs.skill_name stays).
 */
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

        await queryInterface.sequelize.transaction(async (transaction) => {
            const opts = { transaction };

            await queryInterface.createTable(
                'skill_sources',
                {
                    id,
                    app_id: fk('apps'),
                    repo_url: { type: DataTypes.TEXT, allowNull: false },
                    ref: { type: DataTypes.STRING(200), allowNull: true },
                    path: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
                    credential_secret: { type: DataTypes.STRING(100), allowNull: true },
                    last_synced_at: { type: DataTypes.DATE, allowNull: true },
                    last_commit: { type: DataTypes.STRING(64), allowNull: true },
                    last_error: { type: DataTypes.TEXT, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('skill_sources', ['app_id', 'created_at', 'id'], {
                name: 'skill_sources_app_created_idx',
                ...opts,
            });

            await queryInterface.addColumn('skills', 'app_id', fk('apps', { allowNull: true }), opts);
            await queryInterface.addColumn(
                'skills',
                'source',
                { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'builtin' },
                opts,
            );
            await queryInterface.addColumn(
                'skills',
                'source_id',
                fk('skill_sources', { allowNull: true, onDelete: 'SET NULL' }),
                opts,
            );
            await queryInterface.removeIndex('skills', 'skills_name_uq', opts);
            await queryInterface.addIndex('skills', ['app_id', 'name'], {
                name: 'skills_app_name_uq',
                unique: true,
                ...opts,
            });
            await queryInterface.addIndex('skills', ['name'], {
                name: 'skills_gateway_name_uq',
                unique: true,
                where: { app_id: null },
                ...opts,
            });

            await queryInterface.createTable(
                'skill_versions',
                {
                    id,
                    skill_id: fk('skills'),
                    version: { type: DataTypes.STRING(40), allowNull: false },
                    checksum: { type: DataTypes.STRING(64), allowNull: false },
                    manifest: { type: DataTypes.JSONB, allowNull: false },
                    package: { type: DataTypes.BLOB, allowNull: false },
                    size_bytes: { type: DataTypes.INTEGER, allowNull: false },
                    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
                    created_by_key_id: { type: DataTypes.UUID, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('skill_versions', ['skill_id', 'version'], {
                name: 'skill_versions_skill_version_uq',
                unique: true,
                ...opts,
            });
            await queryInterface.addIndex('skill_versions', ['skill_id', 'checksum'], {
                name: 'skill_versions_skill_checksum_idx',
                ...opts,
            });

            await queryInterface.createTable(
                'skill_syncs',
                {
                    id,
                    app_id: fk('apps'),
                    source_id: fk('skill_sources'),
                    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
                    result: { type: DataTypes.JSONB, allowNull: true },
                    error: { type: DataTypes.TEXT, allowNull: true },
                    lease_owner: { type: DataTypes.STRING(200), allowNull: true },
                    started_at: { type: DataTypes.DATE, allowNull: true },
                    heartbeat_at: { type: DataTypes.DATE, allowNull: true },
                    finished_at: { type: DataTypes.DATE, allowNull: true },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('skill_syncs', ['status', 'created_at', 'id'], {
                name: 'skill_syncs_status_created_idx',
                ...opts,
            });
            await queryInterface.addIndex('skill_syncs', ['app_id', 'source_id', 'created_at'], {
                name: 'skill_syncs_app_source_idx',
                ...opts,
            });
            // at most one queued or running sync per source
            await queryInterface.addIndex('skill_syncs', ['source_id'], {
                name: 'skill_syncs_source_active_uq',
                unique: true,
                where: { status: ['queued', 'running'] },
                ...opts,
            });

            await queryInterface.createTable(
                'app_secrets',
                {
                    id,
                    app_id: fk('apps'),
                    name: { type: DataTypes.STRING(100), allowNull: false },
                    value_encrypted: { type: DataTypes.TEXT, allowNull: false },
                    ...timestamps,
                },
                opts,
            );
            await queryInterface.addIndex('app_secrets', ['app_id', 'name'], {
                name: 'app_secrets_app_name_uq',
                unique: true,
                ...opts,
            });

            await queryInterface.addColumn(
                'jobs',
                'skill_id',
                fk('skills', { allowNull: true, onDelete: 'SET NULL' }),
                opts,
            );
            await queryInterface.addColumn(
                'jobs',
                'skill_version_id',
                fk('skill_versions', { allowNull: true, onDelete: 'SET NULL' }),
                opts,
            );
            await queryInterface.addIndex('jobs', ['skill_id'], { name: 'jobs_skill_idx', ...opts });
            await queryInterface.addIndex('jobs', ['skill_version_id'], { name: 'jobs_skill_version_idx', ...opts });
        });

        // Backfill outside the schema transaction, in batches: every existing job ran a gateway skill.
        // raw because: UPDATE ... FROM with a batched sub-select
        for (;;) {
            const [, meta] = await queryInterface.sequelize.query(
                `UPDATE jobs j SET skill_id = s.id
                   FROM skills s
                  WHERE j.id IN (SELECT j2.id FROM jobs j2
                                   JOIN skills s2 ON s2.name = j2.skill_name AND s2.app_id IS NULL
                                  WHERE j2.skill_id IS NULL LIMIT :batch)
                    AND s.name = j.skill_name AND s.app_id IS NULL`,
                { replacements: { batch: BACKFILL_BATCH } },
            );
            if (!meta || !meta.rowCount) break;
        }
    },

    down: async (queryInterface) => {
        await queryInterface.sequelize.transaction(async (transaction) => {
            const opts = { transaction };
            await queryInterface.removeColumn('jobs', 'skill_version_id', opts);
            await queryInterface.removeColumn('jobs', 'skill_id', opts);
            await queryInterface.dropTable('app_secrets', opts);
            await queryInterface.dropTable('skill_syncs', opts);
            await queryInterface.dropTable('skill_versions', opts);
            // app-owned skills cannot survive the old unique index on name
            await queryInterface.sequelize.query('DELETE FROM skills WHERE app_id IS NOT NULL', opts);
            await queryInterface.removeIndex('skills', 'skills_gateway_name_uq', opts);
            await queryInterface.removeIndex('skills', 'skills_app_name_uq', opts);
            await queryInterface.addIndex('skills', ['name'], { name: 'skills_name_uq', unique: true, ...opts });
            await queryInterface.removeColumn('skills', 'source_id', opts);
            await queryInterface.removeColumn('skills', 'source', opts);
            await queryInterface.removeColumn('skills', 'app_id', opts);
            await queryInterface.dropTable('skill_sources', opts);
        });
    },
};
