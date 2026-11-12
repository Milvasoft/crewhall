// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/hash-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'hash-generator',
  name: 'Hash & HMAC Generator',
  description: 'Compute SHA-1/256/384/512 digests and HMACs in your browser via Web Crypto.',
  category: 'security',
  keywords: ['hash', 'sha', 'sha256', 'sha512', 'hmac', 'digest', 'checksum', 'signature'],
  tags: ['generator', 'security'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
  popular: true,
});
