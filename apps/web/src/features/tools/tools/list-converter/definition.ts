// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/list-converter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'list-converter',
  name: 'List Converter',
  description: 'Sort, dedupe, trim, re-case and wrap a list of lines, then join them, locally.',
  category: 'text',
  keywords: [
    'list',
    'lines',
    'sort',
    'dedupe',
    'unique',
    'prefix',
    'suffix',
    'trim',
    'reverse',
    'join',
    'column',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
