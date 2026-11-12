// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-xml/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-xml',
  name: 'JSON ↔ XML',
  description: 'Convert JSON to XML and XML back to JSON, locally, both ways.',
  category: 'json',
  keywords: ['json', 'xml', 'convert', 'soap', 'parse'],
  tags: ['converter', 'formatter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'xml',
});
