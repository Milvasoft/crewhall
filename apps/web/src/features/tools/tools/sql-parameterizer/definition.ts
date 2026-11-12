// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-parameterizer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'sql-parameterizer',
  name: 'SQL Parameterizer',
  description:
    'Replace inline literals in a SQL query with parameters and extract their values, locally.',
  category: 'sql',
  keywords: ['sql', 'parameter', 'parameterize', 'prepared', 'placeholder', 'injection'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'sql',
  outputType: 'sql',
});
