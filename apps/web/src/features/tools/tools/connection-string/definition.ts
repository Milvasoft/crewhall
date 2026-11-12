// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/connection-string/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'connection-string',
  name: 'Connection String Parser',
  description: 'Parse an ADO.NET/database connection string into key-values (and back), locally.',
  category: 'dotnet',
  keywords: [
    'connection string',
    'connectionstring',
    'ado.net',
    'sql',
    'database',
    'parse',
    'dotnet',
  ],
  tags: ['parser', 'dotnet'],
  execution: 'local',
  inputType: 'text',
  outputType: 'json',
});
