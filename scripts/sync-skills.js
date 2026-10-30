'use strict';

/**
 * Validate every folder in the skills directory and register it in the database.
 * Invalid skills are stored disabled with the reason. Exits non-zero if any skill is invalid.
 * Usage: npm run skills:sync
 */
const { sequelize } = require('../src/db/models');
const skillService = require('../src/services/skill.service');
const getLogger = require('../src/utils/logger');

const logger = getLogger(__filename);

const main = async () => {
    try {
        const results = await skillService.syncFromDisk();
        results.forEach((r) =>
            logger.info(`${r.enabled ? 'enabled ' : 'DISABLED'} ${r.name}${r.error ? ` (${r.error})` : ''}`),
        );
        logger.info(`Synced ${results.length} skill(s).`);
        process.exitCode = results.some((r) => !r.enabled) ? 1 : 0;
    } catch (error) {
        logger.error(`Skill sync failed: ${error.message}`, error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
};

main();
