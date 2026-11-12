// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-csv/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-csv',
  name: 'JSON ↔ CSV',
  description: 'Convert an array of JSON objects to CSV and parse CSV back to JSON, locally.',
  category: 'json',
  keywords: ['json', 'csv', 'convert', 'table', 'spreadsheet', 'excel'],
  tags: ['converter', 'formatter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'csv',
});
