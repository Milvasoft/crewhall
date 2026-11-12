// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-formatter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'sql-formatter',
  name: 'SQL Formatter',
  description: 'Format and beautify SQL for many dialects, with keyword casing, all local.',
  category: 'sql',
  keywords: ['sql', 'format', 'beautify', 'prettify', 'query', 'postgres', 'mysql', 'tsql'],
  tags: ['formatter'],
  execution: 'local',
  inputType: 'sql',
  outputType: 'sql',
  popular: true,
});
