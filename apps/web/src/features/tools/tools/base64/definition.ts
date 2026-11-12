// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/base64/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'base64',
  name: 'Base64 Encode / Decode',
  description:
    'Encode text to Base64 or decode Base64 back to text, with URL-safe support, all local.',
  category: 'encoding',
  keywords: ['base64', 'encode', 'decode', 'b64', 'url-safe', 'atob', 'btoa'],
  execution: 'local',
  inputType: 'text',
  outputType: 'base64',
  popular: true,
});
