import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: [
            '.dev-server/**',
            'build/**',
            'test/**',
            'scripts/**',
            'admin/words.js',
            'admin/i18n/**',
            '**/*.d.ts',
        ],
    },
    {
        files: ['**/*.test.ts'],
        rules: {
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            'jsdoc/require-jsdoc': 'off',
        },
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-description': 'off',
        },
    },
];
