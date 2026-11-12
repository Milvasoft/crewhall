// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/http-mime/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'http-mime',
  name: 'HTTP Status & MIME Lookup',
  description: 'Look up HTTP status codes and MIME types with quick search, all local reference.',
  category: 'web',
  keywords: [
    'http',
    'status',
    'code',
    'mime',
    'content-type',
    'media type',
    '404',
    '500',
    'lookup',
    'reference',
  ],
  tags: ['reference'],
  execution: 'local',
  outputType: 'text',
});
