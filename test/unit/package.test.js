'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

describe('npm package', () => {
    const files = JSON.parse(
        execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' }),
    )[0].files.map((f) => f.path);

    it('ships the CLI, the code and only the built-in skills', () => {
        expect(files).toEqual(expect.arrayContaining(['bin/headless-claude.js', 'src/api/server.js', '.sequelizerc']));
        const skills = [...new Set(files.filter((f) => f.startsWith('skills/')).map((f) => f.split('/')[1]))];
        expect(skills.sort()).toEqual(['chat', 'repo-review']);
    });

    it('never ships tests, local env files, data or docs assets', () => {
        const forbidden = files.filter((f) =>
            /^(test\/|var\/|docs\/|\.env\.local|\.gateway-keys|\.secrets|node_modules\/)/.test(f),
        );
        expect(forbidden).toEqual([]);
    });
});
