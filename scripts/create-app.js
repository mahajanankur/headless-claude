'use strict';

/**
 * Create an app and print its first API key (shown once).
 *   npm run app:create -- --name ops --admin
 *   npm run app:create -- --name search-api --skills repo-review --models haiku,sonnet --features waitModeActive
 */
const { sequelize } = require('../src/db/models');
const appService = require('../src/services/app.service');
const getLogger = require('../src/utils/logger');

const logger = getLogger(__filename);

const parse = (argv) => {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        out[key] = next && !next.startsWith('--') ? ((i += 1), next) : true;
    }
    return out;
};

const list = (value) =>
    typeof value === 'string'
        ? value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : undefined;

const main = async () => {
    const args = parse(process.argv.slice(2));
    try {
        if (!args.name || args.name === true)
            throw new Error(
                'Usage: npm run app:create -- --name <name> [--admin] [--skills a,b] [--models haiku,sonnet] [--features f1,f2]',
            );
        const features = Object.fromEntries((list(args.features) || []).map((f) => [f, true]));
        const { app, apiKey } = await appService.createApp({
            name: args.name,
            isAdmin: Boolean(args.admin),
            ...(list(args.skills) ? { allowedSkills: list(args.skills) } : {}),
            ...(list(args.models) ? { allowedModels: list(args.models) } : {}),
            features,
        });
        logger.info(`Created app ${app.name} (${app.id})${app.isAdmin ? ' [admin]' : ''}`);
        process.stdout.write(`\nAPI key (shown once, store it now):\n${apiKey}\n\n`);
    } catch (error) {
        logger.error(`Could not create app: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
};

main();
