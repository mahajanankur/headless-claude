'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
    { ignores: ['node_modules/**', 'var/**', 'test/fixtures/**'] },
    js.configs.recommended,
    prettier,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-console': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'prefer-arrow-callback': 'error',
            strict: ['error', 'global'],
            'max-params': ['warn', 4],
            'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['test/**/*.js'],
        languageOptions: { globals: { ...globals.jest } },
        rules: { 'max-lines-per-function': 'off', 'max-params': 'off' },
    },
    {
        files: ['src/db/migrations/**/*.js', 'src/db/models/**/*.js'],
        rules: { 'max-lines-per-function': 'off' },
    },
];
