// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-table/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'ascii-table',
  name: 'ASCII Table',
  description: 'Browse the full ASCII table with decimal, hex, octal and binary codes, locally.',
  category: 'devutils',
  keywords: [
    'ascii',
    'table',
    'chart',
    'character',
    'code',
    'dec',
    'hex',
    'octal',
    'binary',
    'control',
    'reference',
    'charcode',
  ],
  tags: ['reference'],
  execution: 'local',
});
