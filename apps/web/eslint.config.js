import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'dist',
      'coverage',
      'playwright-report',
      'test-results',
      'public/mockServiceWorker.js',
      'src/routeTree.gen.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      curly: ['error', 'multi-line'],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^\\.\\./', message: 'Use the @/ alias outside the current folder.' },
          ],
        },
      ],
      // randomUUID is undefined outside secure contexts (the web opened over http://<LAN ip>).
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='randomUUID']",
          message: 'Use newId() from @/lib/ids: crypto.randomUUID needs a secure context.',
        },
      ],
    },
  },
  {
    files: ['src/lib/ids.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
