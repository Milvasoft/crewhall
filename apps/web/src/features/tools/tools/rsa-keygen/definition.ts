// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/rsa-keygen/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'rsa-keygen',
  name: 'RSA Key Generator',
  description:
    'Generate an RSA public/private key pair in PEM format, in your browser via Web Crypto.',
  category: 'security',
  keywords: ['rsa', 'key', 'keypair', 'pem', 'public key', 'private key', 'generate'],
  tags: ['generator', 'security'],
  execution: 'local',
  outputType: 'text',
});
