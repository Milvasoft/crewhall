import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Runs in plugin servers (Node), browsers (the bridge) and the CLI: Web APIs only.
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Platform independent: use the base64 helpers.' },
      ],
    },
  },
);
