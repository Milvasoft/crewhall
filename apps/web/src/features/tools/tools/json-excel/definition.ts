// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-excel/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-excel',
  name: 'JSON ↔ Excel',
  description:
    'Turn a JSON array of objects into an Excel (.xlsx) file, or read a spreadsheet back to JSON, locally.',
  category: 'data',
  keywords: ['json', 'excel', 'xlsx', 'spreadsheet', 'sheet', 'convert', 'export', 'csv'],
  tags: ['converter', 'export'],
  execution: 'local',
  inputType: 'json',
  outputType: 'json',
});
