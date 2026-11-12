// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/aes/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'aes',
  name: 'AES Encrypt / Decrypt',
  description: 'Encrypt or decrypt text with AES-256-GCM and a passphrase (PBKDF2), all local.',
  category: 'security',
  keywords: ['aes', 'encrypt', 'decrypt', 'gcm', 'pbkdf2', 'cipher', 'symmetric'],
  tags: ['security'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
