import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
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
    // Sample data may name the example tenant.
    files: ['src/scripts/seed.ts', 'src/scripts/seed-data.ts', 'test/**', 'eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
