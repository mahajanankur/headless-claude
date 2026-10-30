'use strict';

/**
 * Regenerate the tables in docs/configuration.md from config/default.json and
 * config/custom-environment-variables.json. Run after adding or renaming a config key:
 *   npm run docs:config
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'configuration.md');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', file), 'utf8'));

const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v) && !('__name' in v)
            ? flatten(v, `${prefix}${k}.`)
            : [[`${prefix}${k}`, v]],
    );

const envTable = () =>
    flatten(read('custom-environment-variables.json')).map(([key, v]) => {
        const name = typeof v === 'string' ? v : v.__name;
        const format = typeof v === 'string' ? '' : v.__format === 'json' ? 'JSON' : v.__format;
        return `| \`${name}\` | \`${key}\` | ${format || ''} |`;
    });

const sectionTable = () =>
    Object.entries(read('default.json')).map(
        ([section, v]) =>
            `| \`${section}\` | ${Object.keys(v)
                .map((k) => `\`${k}\``)
                .join(', ')} |`,
    );

const replaceTable = (doc, heading, header, rows) => {
    const start = doc.indexOf(heading);
    if (start === -1) throw new Error(`Heading not found: ${heading}`);
    const tableStart = doc.indexOf(header, start);
    const tableEnd = doc.indexOf('\n\n', tableStart);
    return `${doc.slice(0, tableStart)}${header}\n${rows.join('\n')}${doc.slice(tableEnd)}`;
};

let doc = fs.readFileSync(DOC, 'utf8');
doc = replaceTable(doc, '## Environment variables', '| Variable | Key | Format |\n|---|---|---|', envTable());
doc = replaceTable(doc, '## Keys by section', '| Section | Keys |\n|---|---|', sectionTable());
fs.writeFileSync(DOC, doc);
process.stdout.write(`Updated ${path.relative(ROOT, DOC)}\n`);
