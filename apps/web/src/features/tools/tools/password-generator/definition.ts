// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'password-generator',
  name: 'Password & Key Generator',
  description: 'Generate strong random passwords and encryption keys (hex/base64) in your browser.',
  category: 'security',
  keywords: [
    'password',
    'key',
    'generator',
    'random',
    'secret',
    'encryption key',
    'token',
    'entropy',
  ],
  tags: ['generator', 'security'],
  execution: 'local',
  outputType: 'text',
  popular: true,
});
