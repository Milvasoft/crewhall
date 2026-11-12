// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csv-viewer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'csv-viewer',
  name: 'CSV Viewer',
  description: 'View and sort CSV data as a table, parsed locally in your browser.',
  category: 'data',
  keywords: ['csv', 'viewer', 'table', 'spreadsheet', 'tsv', 'delimited'],
  tags: ['viewer'],
  execution: 'local',
  inputType: 'csv',
});
