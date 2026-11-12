import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/Milvasoft/i]',
          message: 'Tenant names come from branding; do not hardcode them (CLAUDE.md).',
        },
      ],
    },
  },
  {
    // The rule's own pattern names the example tenant.
    files: ['eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
