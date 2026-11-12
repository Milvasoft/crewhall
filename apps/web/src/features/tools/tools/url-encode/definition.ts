// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-encode/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'url-encode',
  name: 'URL Encode / Decode',
  description: 'Percent-encode or decode text and URLs, component-wise or whole, all local.',
  category: 'web',
  keywords: ['url', 'uri', 'encode', 'decode', 'percent', 'escape', 'querystring'],
  tags: ['converter', 'encoding'],
  execution: 'local',
  inputType: 'text',
  outputType: 'url',
});
