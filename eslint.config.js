// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'] },
  { ...js.configs.recommended, files: ['**/*.{js,ts}'] },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='eval'], NewExpression[callee.name='Function']",
          message: 'Dynamic code evaluation is forbidden.',
        },
      ],
    },
  },
  {
    // The pure core must stay free of I/O, clock and randomness (ARCHITECTURE.md §3, D-003).
    files: ['packages/domain/src/**/*.ts', 'packages/calc-engine/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'Pure core: no I/O modules.',
            },
            {
              group: [
                '@costgenius/db',
                '@costgenius/ai-assist',
                '@costgenius/reporting',
                '@costgenius/projects',
              ],
              message: 'Pure core may not depend on outer layers.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Pure core must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Pure core must not read the clock.' },
      ],
    },
  },
);
