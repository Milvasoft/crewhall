// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-to-json/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'sql-to-json',
  name: 'SQL → JSON',
  description: 'Turn SQL INSERT statements into JSON rows, parsed locally in your browser.',
  category: 'sql',
  keywords: ['sql', 'json', 'insert', 'convert', 'rows', 'seed', 'dump'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'sql',
  outputType: 'json',
});
