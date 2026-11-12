// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bcrypt-tool/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'bcrypt-tool',
  name: 'Bcrypt Hash & Verify',
  description:
    'Hash a password with bcrypt at a chosen cost, or verify one against a hash, locally.',
  category: 'security',
  keywords: ['bcrypt', 'hash', 'password', 'verify', 'salt', 'cost', 'rounds', 'compare'],
  tags: ['security'],
  execution: 'local',
});
