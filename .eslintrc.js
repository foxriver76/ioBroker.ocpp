module.exports = {
	root: true, // Don't look outside this project for inherited configs
	parserOptions: {
		ecmaVersion: 2018, // Allows for the parsing of modern ECMAScript features
		sourceType: 'module', // Allows for the use of imports
		project: './tsconfig.json',
	},
	extends: [
		'plugin:prettier/recommended',
	],
	plugins: [],
	rules: {
		'quotes': [
			'error',
			'single',
			{
				'avoidEscape': true,
				'allowTemplateLiterals': true
			}
		],
		'no-var': 'error',
		'prefer-const': 'error',
		'no-trailing-spaces': 'error',
	},
	overrides: [
		{
			files: ['*.test.ts'],
			rules: {
				'@typescript-eslint/explicit-function-return-type': 'off',
			}
		},
		{
			files: ['*.ts'],
			parser: '@typescript-eslint/parser',
			extends: [
				'plugin:@typescript-eslint/recommended' // Uses the recommended rules from the @typescript-eslint/eslint-plugin
			],
			rules: {
				'@typescript-eslint/no-parameter-properties': 'off',
				'@typescript-eslint/no-explicit-any': 'off',
				'@typescript-eslint/no-use-before-define': [
					'error',
					{
						functions: false,
						typedefs: false,
						classes: false,
					},
				],
				'@typescript-eslint/no-unused-vars': [
					'error',
					{
						ignoreRestSiblings: true,
						argsIgnorePattern: '^_',
					},
				],
				'@typescript-eslint/explicit-function-return-type': [
					'warn',
					{
						allowExpressions: true,
						allowTypedFunctionExpressions: true,
					},
				],
				'@typescript-eslint/no-object-literal-type-assertion': 'off',
				'@typescript-eslint/interface-name-prefix': 'off',
				'@typescript-eslint/no-non-null-assertion': 'off', // This is necessary for Map.has()/get()!
			}
		}
	],
};
