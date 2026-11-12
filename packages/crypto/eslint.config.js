import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The package runs in browsers, Node and React Native: no platform globals.
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Platform independent: no DOM globals.' },
        { name: 'document', message: 'Platform independent: no DOM globals.' },
        { name: 'Buffer', message: 'Platform independent: use Uint8Array helpers.' },
        { name: 'process', message: 'Platform independent: no Node globals.' },
        {
          name: 'TextEncoder',
          message: 'Hermes lacks full TextEncoder; use utf8() from bytes.ts.',
        },
        { name: 'TextDecoder', message: 'Hermes lacks TextDecoder; use fromUtf8() from bytes.ts.' },
        { name: 'atob', message: 'Use base64 helpers from bytes.ts.' },
        { name: 'btoa', message: 'Use base64 helpers from bytes.ts.' },
      ],
    },
  },
  {
    files: ['test/**', 'scripts/**'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
