// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/unicode-inspector/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'unicode-inspector',
  name: 'ASCII / Unicode Inspector',
  description: 'Inspect each character: code point, UTF-8/UTF-16 bytes and HTML entity, locally.',
  category: 'devutils',
  keywords: [
    'unicode',
    'ascii',
    'codepoint',
    'utf-8',
    'utf-16',
    'character',
    'entity',
    'hex',
    'inspect',
  ],
  tags: ['reference'],
  execution: 'local',
  inputType: 'text',
});
