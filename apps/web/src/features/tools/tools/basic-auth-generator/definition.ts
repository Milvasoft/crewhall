// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/basic-auth-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'basic-auth-generator',
  name: 'Basic Auth Generator',
  description: 'Turn a username and password into an HTTP Basic Authorization header, locally.',
  category: 'security',
  keywords: [
    'basic',
    'auth',
    'authorization',
    'header',
    'http',
    'base64',
    'credentials',
    'curl',
    'rfc7617',
  ],
  tags: ['security', 'web'],
  execution: 'local',
});
